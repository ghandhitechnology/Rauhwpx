#!/usr/bin/env python3
"""Render the 20 samples and 10 synthetic fixtures against official PDF exports.

Metrics locate differences; only recorded visual review can assess fidelity.
Run from any directory. No proprietary fonts or official PDFs are redistributed.
"""
import argparse
from datetime import datetime, timezone
import hashlib
import importlib.util
import json
from pathlib import Path
import platform
import re
import subprocess

import fitz
from PIL import Image, ImageDraw

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
spec = importlib.util.spec_from_file_location("oracle", ROOT / "scripts/visual_oracle_native.py")
oracle = importlib.util.module_from_spec(spec)
spec.loader.exec_module(oracle)


def sha256(path):
    with Path(path).open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def file_record(path):
    return {"path": str(path), "sha256": sha256(path)}


def corpus(synthetic_prefix):
    documents = json.loads((HERE / "sample_manifest.json").read_text())["documents"]
    for item in json.loads((HERE / "synthetic_manifest.json").read_text())["documents"]:
        documents.append({"id": Path(item["file"]).stem,
                          "source": "samples/rendering-fidelity/" + item["file"],
                          "official_pdf": synthetic_prefix + Path(item["file"]).stem + ".pdf",
                          "features": item["features"]})
    return documents


def export_all(binary, source, output, dpi, fonts):
    output.mkdir(parents=True)
    command = [str(binary), "export-png", str(source), "-o", str(output), "--dpi", str(dpi)]
    for font in fonts:
        command += ["--font-path", str(font)]
    result = subprocess.run(command, capture_output=True, text=True, errors="replace")
    (output / "export.log").write_text(result.stdout + result.stderr)
    if result.returncode:
        raise RuntimeError(f"Renderer exited {result.returncode}: {output / 'export.log'}")
    def page_number(path):
        suffix = re.search(r"_(\d+)\.png$", path.name)
        return int(suffix[1]) if suffix else 0

    pages = sorted(output.glob("*.png"), key=page_number)
    if not pages:
        raise RuntimeError(f"No rendered pages: {output}")
    return pages


def comparison(native, official, directory, page):
    actual = Image.open(native).convert("RGB")
    expected = Image.open(official).convert("RGB")
    a, b = oracle.to_common_canvas(actual, expected)
    metrics, masks = oracle.compute_metrics(a, b)
    # Background agreement is deliberately omitted: it obscures missing content.
    metrics.pop("pixel_match_percent", None)
    metrics.pop("visual_accuracy_proxy_percent", None)
    review = directory / f"review_{page:03}.png"
    oracle.build_review(a, b, oracle.build_overlay(a, b, masks),
                        f"Page {page}: visual review required; metrics are diagnostic only").save(review)
    return {"page": page, "native_size": actual.size, "official_size": expected.size,
            **metrics, "review": str(review)}


def panel(before, after, official, output):
    images = [Image.open(p).convert("RGB") for p in (before, after, official)]
    width, height = max(i.width for i in images), max(i.height for i in images)
    result = Image.new("RGB", (3 * width, height + 30), "white")
    draw = ImageDraw.Draw(result)
    for index, (label, img) in enumerate(zip(("Before", "After", "Official Hancom"), images)):
        draw.text((index * width + 8, 8), label, fill="black")
        result.paste(img, (index * width, 30))
    result.save(output)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--baseline-bin", required=True, type=Path)
    parser.add_argument("--after-bin", required=True, type=Path)
    parser.add_argument("--official-dir", required=True, type=Path)
    parser.add_argument("--out", required=True, type=Path, help="New output directory; existing output is never reused")
    parser.add_argument("--font-path", action="append", type=Path, default=[])
    parser.add_argument("--id", action="append", help="Select document IDs; default is all 30")
    parser.add_argument("--dpi", type=float, default=96)
    parser.add_argument("--official-version", required=True, help="Installed editor version/build used to export PDFs")
    parser.add_argument("--synthetic-prefix", default="verified-", help="Prefix on synthetic reference PDF filenames")
    args = parser.parse_args()
    args.out = args.out.resolve()
    args.out.mkdir(parents=True, exist_ok=False)
    binaries = {name: path.resolve() for name, path in (("before", args.baseline_bin), ("after", args.after_bin))}
    fonts = [p.resolve() for p in args.font_path]
    font_files = sorted({f for p in fonts for f in ([p] if p.is_file() else p.rglob("*"))
                         if f.is_file() and f.suffix.lower() in (".ttf", ".ttc", ".otf")})
    report = {"schema_version": 1, "started_utc": datetime.now(timezone.utc).isoformat(),
              "platform": platform.platform(), "dpi": args.dpi, "official_version": args.official_version,
              "binaries": {k: file_record(v) for k, v in binaries.items()},
              "font_paths": list(map(str, fonts)), "font_files": [file_record(f) for f in font_files],
              "visual_review_status": "pending", "documents": []}
    selected = [d for d in corpus(args.synthetic_prefix) if not args.id or d["id"] in args.id]
    if args.id and set(args.id) - {d["id"] for d in selected}:
        parser.error("Unknown document ID")
    failures = 0
    for item in selected:
        result = {**item, "visual_review_status": "pending"}
        report["documents"].append(result)
        try:
            source = ROOT / item["source"]
            reference = args.official_dir.resolve() / item["official_pdf"]
            result.update(source_record=file_record(source), official_record=file_record(reference))
            destination = args.out / item["id"]
            destination.mkdir()
            with fitz.open(reference) as pdf:
                result["official_pages"] = len(pdf)
                official = []
                for index in range(len(pdf)):
                    path = destination / f"official_{index + 1:03}.png"
                    oracle.render_pdf_png(pdf, index, args.dpi, str(path))
                    official.append(path)
            rendered = {}
            for stage, binary in binaries.items():
                folder = destination / stage
                # The native CLI does not recurse through --font-path directories.
                # Pass the exact hashed files so provenance matches font loading.
                pages = export_all(binary, source, folder, args.dpi, font_files)
                rendered[stage] = pages
                result[stage] = {"pages": len(pages), "comparisons": [
                    comparison(page, ref, folder, n) for n, (page, ref) in enumerate(zip(pages, official), 1)]}
            result["page_counts_match"] = all(len(pages) == len(official) for pages in rendered.values())
            for index, pages in enumerate(zip(rendered["before"], rendered["after"], official), 1):
                panel(*pages, destination / f"before-after-official_{index:03}.png")
            result["render_status"] = "complete"
            if not result["page_counts_match"]:
                failures += 1
        except Exception as error:
            result.update(render_status="failed", error=str(error))
            failures += 1
        (args.out / "report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
        print(f"{item['id']}: {result['render_status']}; visual review pending", flush=True)
    print(f"Report: {args.out / 'report.json'}; no visual parity verdict was generated.")
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
