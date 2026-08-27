#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import struct
import zipfile
from collections import OrderedDict
from pathlib import Path
from typing import Any


DEFAULT_MAX_PIXELS = 16_777_216
DEFAULT_MAX_ENTRIES = 200


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Compare the current count-based image cache with a pixel-budgeted LRU."
    )
    parser.add_argument("sample", help="HWPX sample path")
    parser.add_argument("--max-pixels", type=int, default=DEFAULT_MAX_PIXELS)
    parser.add_argument("--max-entries", type=int, default=DEFAULT_MAX_ENTRIES)
    parser.add_argument("--output", help="optional JSON result path")
    return parser.parse_args()


def fnv1a64(data: bytes) -> int:
    value = 0xCBF29CE484222325
    for byte in data:
        value ^= byte
        value = value * 0x100000001B3 & 0xFFFFFFFFFFFFFFFF
    return value


def jpeg_dimensions(data: bytes) -> tuple[int, int] | None:
    if not data.startswith(b"\xff\xd8"):
        return None
    offset = 2
    sof = {
        0xC0,
        0xC1,
        0xC2,
        0xC3,
        0xC5,
        0xC6,
        0xC7,
        0xC9,
        0xCA,
        0xCB,
        0xCD,
        0xCE,
        0xCF,
    }
    while offset + 4 <= len(data):
        if data[offset] != 0xFF:
            offset += 1
            continue
        while offset < len(data) and data[offset] == 0xFF:
            offset += 1
        if offset >= len(data):
            return None
        marker = data[offset]
        offset += 1
        if marker in {0x01, *range(0xD0, 0xDA)}:
            continue
        if offset + 2 > len(data):
            return None
        length = int.from_bytes(data[offset : offset + 2], "big")
        if length < 2 or offset + length > len(data):
            return None
        if marker in sof and length >= 7:
            height = int.from_bytes(data[offset + 3 : offset + 5], "big")
            width = int.from_bytes(data[offset + 5 : offset + 7], "big")
            return width, height
        offset += length
    return None


def tiff_dimensions(data: bytes) -> tuple[int, int] | None:
    if len(data) < 8 or data[:2] not in {b"II", b"MM"}:
        return None
    endian = "<" if data[:2] == b"II" else ">"
    if struct.unpack_from(f"{endian}H", data, 2)[0] != 42:
        return None
    ifd = struct.unpack_from(f"{endian}I", data, 4)[0]
    if ifd + 2 > len(data):
        return None
    count = struct.unpack_from(f"{endian}H", data, ifd)[0]
    values: dict[int, int] = {}
    for index in range(count):
        offset = ifd + 2 + index * 12
        if offset + 12 > len(data):
            break
        tag, field_type, field_count = struct.unpack_from(f"{endian}HHI", data, offset)
        if tag not in {256, 257} or field_count != 1:
            continue
        if field_type == 3:
            values[tag] = struct.unpack_from(f"{endian}H", data, offset + 8)[0]
        elif field_type == 4:
            values[tag] = struct.unpack_from(f"{endian}I", data, offset + 8)[0]
    if values.get(256, 0) > 0 and values.get(257, 0) > 0:
        return values[256], values[257]
    return None


def image_dimensions(data: bytes) -> tuple[int, int] | None:
    if data.startswith(b"\x89PNG\r\n\x1a\n") and len(data) >= 24:
        return struct.unpack_from(">II", data, 16)
    if data[:6] in {b"GIF87a", b"GIF89a"} and len(data) >= 10:
        return struct.unpack_from("<HH", data, 6)
    if data.startswith(b"BM") and len(data) >= 26:
        width, height = struct.unpack_from("<ii", data, 18)
        return abs(width), abs(height)
    return jpeg_dimensions(data) or tiff_dimensions(data)


def current_peak(accesses: list[tuple[int, int]], max_entries: int) -> tuple[int, int]:
    cache: dict[int, int] = {}
    total = 0
    peak = 0
    for key, pixels in accesses:
        if key in cache:
            continue
        if len(cache) > max_entries:
            cache.clear()
            total = 0
        cache[key] = pixels
        total += pixels
        peak = max(peak, total)
    return peak, len(cache)


def budgeted_peak(
    accesses: list[tuple[int, int]], max_entries: int, max_pixels: int
) -> tuple[int, int]:
    cache: OrderedDict[int, int] = OrderedDict()
    total = 0
    peak = 0
    for key, pixels in accesses:
        if key in cache:
            cache.move_to_end(key)
            continue
        cache[key] = pixels
        total += pixels
        while len(cache) > max_entries or (total > max_pixels and len(cache) > 1):
            _, evicted = cache.popitem(last=False)
            total -= evicted
        peak = max(peak, total)
    return peak, len(cache)


def main() -> None:
    args = parse_args()
    if args.max_pixels < 1 or args.max_entries < 1:
        raise SystemExit("--max-pixels and --max-entries must be positive")
    sample = Path(args.sample).resolve()
    accesses: list[tuple[int, int]] = []
    decoded = 0
    with zipfile.ZipFile(sample) as archive:
        names = [name for name in archive.namelist() if name.lower().startswith("bindata/")]
        for name in names:
            data = archive.read(name)
            dimensions = image_dimensions(data)
            pixels = 0 if dimensions is None else dimensions[0] * dimensions[1]
            decoded += int(pixels > 0)
            accesses.append((fnv1a64(data), pixels))

    current_pixels, current_entries = current_peak(accesses, args.max_entries)
    budgeted_pixels, budgeted_entries = budgeted_peak(
        accesses, args.max_entries, args.max_pixels
    )
    result: dict[str, Any] = {
        "sample": str(sample),
        "embeddedAssets": len(accesses),
        "dimensionedImages": decoded,
        "uniqueAssets": len({key for key, _ in accesses}),
        "maxEntries": args.max_entries,
        "maxPixels": args.max_pixels,
        "currentCountCache": {
            "peakPixels": current_pixels,
            "peakRgbaBytes": current_pixels * 4,
            "finalEntries": current_entries,
        },
        "budgetedLru": {
            "peakPixels": budgeted_pixels,
            "peakRgbaBytes": budgeted_pixels * 4,
            "finalEntries": budgeted_entries,
        },
        "peakRgbaChangePercent": round(
            (budgeted_pixels - current_pixels) / current_pixels * 100, 3
        )
        if current_pixels
        else 0.0,
    }
    serialized = json.dumps(result, ensure_ascii=False, indent=2)
    print(serialized)
    if args.output:
        output = Path(args.output)
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_text(serialized + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
