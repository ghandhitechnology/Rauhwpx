#!/usr/bin/env python3
"""Rebuild packaging and UI icons from the B&W 1024 master.

Extracts the white hippo strokes from a source PNG (or uses a black-background
master as-is) and writes the logo PNG ladder, favicon.ico, Electron icns/ico,
Studio PWA icons, and VS Code icon.
"""

from __future__ import annotations

import shutil
import subprocess
import sys
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
LOGO_DIR = ROOT / "rhwp" / "assets" / "logo"
BUILD_DIR = ROOT / "build"
STUDIO_PUBLIC = ROOT / "rhwp" / "rhwp-studio" / "public"
VSCODE_ICON = ROOT / "rhwp" / "rhwp-vscode" / "media" / "icon.png"
CREDITS_ICON = ROOT / "rhwp" / "rau-credits" / "public" / "rau.png"
PNG_SIZES = (16, 32, 128, 256, 300, 512, 1024)
ICO_SIZES = (16, 32, 48, 64, 128, 256)
ICNS_SIZES = (16, 32, 64, 128, 256, 512, 1024)


def load_master(path: Path) -> Image.Image:
    src = Image.open(path).convert("RGBA")
    pixels = list(src.getdata())
    blues = 0
    blacks = 0
    for r, g, b, a in pixels[:: max(1, len(pixels) // 4096)]:
        if a < 16:
            continue
        if b > r + 40 and b > g + 20:
            blues += 1
        if r < 24 and g < 24 and b < 24:
            blacks += 1
    if blues > blacks:
        return hippo_on_black(src)
    return src.resize((1024, 1024), Image.Resampling.LANCZOS)


def hippo_on_black(src: Image.Image) -> Image.Image:
    """Keep near-white strokes and place them on a pure black square."""
    src = src.convert("RGBA")
    w, h = src.size
    xs: list[int] = []
    ys: list[int] = []
    out_px = []
    for y in range(h):
        for x in range(w):
            r, g, b, a = src.getpixel((x, y))
            luma = 0.299 * r + 0.587 * g + 0.114 * b
            if a > 16 and luma > 200:
                xs.append(x)
                ys.append(y)
                out_px.append((x, y, 255, 255, 255, 255))
    if not xs:
        raise SystemExit(f"no white strokes in {src.size}")
    min_x, max_x = min(xs), max(xs)
    min_y, max_y = min(ys), max(ys)
    crop = src.crop((min_x, min_y, max_x + 1, max_y + 1))
    hippo = Image.new("RGBA", crop.size, (0, 0, 0, 255))
    for x, y, r, g, b, a in out_px:
        hippo.putpixel((x - min_x, y - min_y), (255, 255, 255, 255))
    side = max(hippo.size)
    pad = int(side * 0.08)
    canvas = Image.new("RGBA", (side + 2 * pad, side + 2 * pad), (0, 0, 0, 255))
    ox = (canvas.size[0] - hippo.size[0]) // 2
    oy = (canvas.size[1] - hippo.size[1]) // 2
    canvas.paste(hippo, (ox, oy), hippo)
    return canvas.resize((1024, 1024), Image.Resampling.LANCZOS)


def write_pngs(master: Image.Image) -> None:
    LOGO_DIR.mkdir(parents=True, exist_ok=True)
    for size in PNG_SIZES:
        dest = LOGO_DIR / f"logo-{size}.png"
        resized = master.resize((size, size), Image.Resampling.LANCZOS)
        resized.save(dest, format="PNG", optimize=True)
        print(f"wrote {dest}")


def run(cmd: list[str]) -> None:
    subprocess.run(cmd, check=True)


def write_favicon_and_ico(master: Image.Image) -> None:
    tmp = ROOT / ".icon-work"
    if tmp.exists():
        shutil.rmtree(tmp)
    tmp.mkdir()
    ico_pngs = []
    for size in ICO_SIZES:
        p = tmp / f"icon-{size}.png"
        master.resize((size, size), Image.Resampling.LANCZOS).save(p)
        ico_pngs.append(str(p))
    favicon = LOGO_DIR / "favicon.ico"
    electron_ico = BUILD_DIR / "icon.ico"
    BUILD_DIR.mkdir(parents=True, exist_ok=True)
    run(["icotool", "-c", "-o", str(favicon), *ico_pngs])
    shutil.copy2(favicon, electron_ico)
    studio_favicon = STUDIO_PUBLIC / "favicon.ico"
    shutil.copy2(favicon, studio_favicon)
    print(f"wrote {favicon}")
    print(f"wrote {electron_ico}")
    print(f"wrote {studio_favicon}")


def write_icns(master: Image.Image) -> None:
    tmp = ROOT / ".icon-work" / "icns"
    tmp.mkdir(parents=True, exist_ok=True)
    pngs = []
    for size in ICNS_SIZES:
        p = tmp / f"icon_{size}x{size}.png"
        master.resize((size, size), Image.Resampling.LANCZOS).save(p)
        pngs.append(str(p))
    dest = BUILD_DIR / "icon.icns"
    run(["png2icns", str(dest), *pngs])
    print(f"wrote {dest}")


def strokes_on_transparent(master: Image.Image, size: int) -> Image.Image:
    """CSS mask consumers need the hippo as alpha, not a black square."""
    scaled = master.resize((size, size), Image.Resampling.LANCZOS)
    out = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    src = scaled.load()
    dst = out.load()
    for y in range(size):
        for x in range(size):
            r, g, b, a = src[x, y]
            luma = int(0.299 * r + 0.587 * g + 0.114 * b)
            if a > 0 and luma > 16:
                dst[x, y] = (255, 255, 255, luma)
    return out


def write_ui_copies(master: Image.Image) -> None:
    studio_icons = STUDIO_PUBLIC / "icons"
    for size in (128, 192, 256, 512):
        dest = studio_icons / f"icon-{size}.png"
        master.resize((size, size), Image.Resampling.LANCZOS).save(
            dest, format="PNG", optimize=True
        )
        print(f"wrote {dest}")
    rau = strokes_on_transparent(master, 128)
    rau.save(studio_icons / "rau.png", format="PNG", optimize=True)
    rau.save(CREDITS_ICON, format="PNG", optimize=True)
    master.resize((128, 128), Image.Resampling.LANCZOS).save(
        VSCODE_ICON, format="PNG", optimize=True
    )
    print(f"wrote {studio_icons / 'rau.png'}")
    print(f"wrote {CREDITS_ICON}")
    print(f"wrote {VSCODE_ICON}")


def main() -> int:
    candidates = [
        ROOT / "rauhwpx-logo" / "logo-bw-1024.png",
        Path("/workspace/rauhwpx-logo/logo-bw-1024.png"),
        LOGO_DIR / "logo-1024.png",
    ]
    if len(sys.argv) > 1:
        candidates.insert(0, Path(sys.argv[1]))
    src = next((p for p in candidates if p.is_file()), None)
    if src is None:
        raise SystemExit("no logo master PNG found")
    print(f"master {src}")
    master = load_master(src)
    write_pngs(master)
    write_favicon_and_ico(master)
    write_icns(master)
    write_ui_copies(master)
    shutil.rmtree(ROOT / ".icon-work", ignore_errors=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
