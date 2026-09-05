#!/usr/bin/env python3
"""Compare the six diagnostic SVG layouts with separately captured Hancom PDFs.

This checks opening Rau's output in Hancom, not independently reproducing edits.
Run with: uv run --with pymupdf python compare_diagnostic_exports.py RUN_DIRECTORY
"""

import argparse
import hashlib
import json
from pathlib import Path
import sys
import xml.etree.ElementTree as ET


def sha256(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def group_lines(chunks, tolerance=0.2):
    """Group horizontal text by baseline. Whitespace is absent from some SVGs."""
    lines = []
    for chunk in sorted(chunks, key=lambda item: (item["y"], item["x"])):
        text = "".join(chunk["text"].split())
        if not text:
            continue
        line = next((line for line in lines if abs(line["y"] - chunk["y"]) <= tolerance), None)
        if line is None:
            line = {"y": chunk["y"], "chunks": []}
            lines.append(line)
        line["chunks"].append({**chunk, "text": text})
    return [
        {"text": "".join(c["text"] for c in sorted(line["chunks"], key=lambda c: c["x"])),
         "x": min(c["x"] for c in line["chunks"]), "y": line["y"]}
        for line in lines
    ]


def svg_lines(path, dpi):
    root = ET.parse(path).getroot()
    chunks = []
    # These generated cases have no transformed text. Refuse instead of making
    # incorrect geometry claims if that changes when the fixture set expands.
    for element in root.iter():
        if "transform" in element.attrib and element.tag.endswith(("}g", "}text")):
            raise ValueError(f"Transformed SVG text is outside this comparator's scope: {path}")
        if element.tag.endswith("}text"):
            chunks.append({"text": "".join(element.itertext()),
                           "x": float(element.get("x", "0")) * 72 / dpi,
                           "y": float(element.get("y", "0")) * 72 / dpi})
    return group_lines(chunks)


def pdf_layout(page):
    chunks = []
    for block in page.get_text("dict")["blocks"]:
        if block["type"] != 0:
            continue
        for line in block["lines"]:
            if line["dir"] != (1.0, 0.0):
                raise ValueError("Non-horizontal PDF text is outside this comparator's scope")
            for span in line["spans"]:
                chunks.append({"text": span["text"], "x": span["origin"][0], "y": span["origin"][1]})
    return group_lines(chunks)


def compare(root, reference_root=None):
    import pymupdf

    manifest = json.loads((root / "manifest.json").read_text())
    if manifest.get("schemaVersion") != 2 or not manifest.get("cases"):
        raise ValueError("Expected a nonempty version-2 diagnostic manifest")
    reference_root = reference_root or root
    dpi = manifest["layoutDpi"]
    tolerance = manifest["acceptance"]["positionTolerancePt"]
    results = []
    for case in manifest["cases"]:
        directory = root / case["id"]
        reference_directory = reference_root / case["id"]
        pdf_path = reference_directory / "hancom-opened-rau.pdf"
        if not pdf_path.is_file():
            results.append({"id": case["id"], "status": "pending-export"})
            continue
        if sha256(directory / "edited.hwpx") != sha256(reference_directory / "edited.hwpx"):
            results.append({"id": case["id"], "status": "reference-input-changed",
                            "sourceSha256": sha256(directory / "edited.hwpx"),
                            "referenceInputSha256": sha256(reference_directory / "edited.hwpx"),
                            "reason": "Capture a new Hancom export; the old PDF was not compared"})
            continue
        with pymupdf.open(pdf_path) as doc:
            same_pages = doc.page_count == case["editedLiveLayout"]["pageCount"]
            pages = []
            for index in range(min(doc.page_count, case["editedLiveLayout"]["pageCount"])):
                rau_lines = svg_lines(directory / f"edited-live-page-{index + 1}.svg", dpi)
                official_lines = pdf_layout(doc[index])
                same_lines = [line["text"] for line in rau_lines] == [line["text"] for line in official_lines]
                line_deltas = [
                    {"text": a["text"], "dxPt": b["x"] - a["x"], "dyPt": b["y"] - a["y"]}
                    for a, b in zip(rau_lines, official_lines)
                ] if same_lines else None
                rau_images = [c for c in case["editedLiveLayout"]["pages"][index]["controls"] if c["type"] == "image"]
                official_images = doc[index].get_image_info()
                # Each of the initial six recipes inserts exactly one image.
                # Do not silently pair objects by paint order in future cases.
                if len(rau_images) != 1 or len(official_images) != 1:
                    raise ValueError(f"Expected one image per page in {case['id']}")
                a = rau_images[0]
                x0, y0, x1, y1 = official_images[0]["bbox"]
                image_delta = {"dxPt": x0 - a["x"] * 72 / dpi, "dyPt": y0 - a["y"] * 72 / dpi,
                               "dwPt": x1 - x0 - a["w"] * 72 / dpi, "dhPt": y1 - y0 - a["h"] * 72 / dpi}
                passes = same_lines and all(abs(v) <= tolerance for v in image_delta.values())
                passes = passes and all(abs(d[k]) <= tolerance for d in line_deltas for k in ("dxPt", "dyPt"))
                pages.append({"page": index + 1, "passesCheckedGeometry": passes,
                              "sameNonWhitespaceLineBreaks": same_lines, "imageDelta": image_delta,
                              "lineStartDeltas": line_deltas, "rauLines": rau_lines, "hancomLines": official_lines,
                              "pdfFonts": sorted({font[3] for font in doc[index].get_fonts()})})
            results.append({"id": case["id"], "status": "pass" if same_pages and all(p["passesCheckedGeometry"] for p in pages) else "fail",
                            "samePageCount": same_pages, "sourceSha256": sha256(directory / "edited.hwpx"),
                            "pdfSha256": sha256(pdf_path), "pdfMetadata": doc.metadata, "pages": pages})
    return {"schemaVersion": 1, "comparison": "rau-export-opened-in-hancom", "fullParityVerified": False,
            "fontMetricsPolicy": manifest.get("fontMetricsPolicy", "HancomWindows"),
            "independentEditReproduction": "pending", "positionTolerancePt": tolerance,
            "limitations": ["Initial single-image horizontal-text diagnostic recipes only",
                            "Whitespace placement and individual glyph positions are not gated",
                            "PDF producer metadata alone does not prove Hancom provenance; retain the capture record"],
            "cases": results}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("run_directory", type=Path)
    parser.add_argument("--reference-directory", type=Path,
                        help="Reuse captured PDFs only when edited HWPX bytes match exactly")
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    if args.output and args.output.exists():
        parser.error("Output already exists; retain prior comparison evidence")
    report = compare(args.run_directory, args.reference_directory)
    rendered = json.dumps(report, ensure_ascii=False, indent=2) + "\n"
    if args.output:
        args.output.write_text(rendered)
    else:
        print(rendered, end="")
    for case in report["cases"]:
        print(f"{case['id']}: {case['status']}", file=sys.stderr)
    return 0 if all(c["status"] == "pass" for c in report["cases"]) else 1


if __name__ == "__main__":
    sys.exit(main())
