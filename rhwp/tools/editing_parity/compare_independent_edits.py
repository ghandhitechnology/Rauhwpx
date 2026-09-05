#!/usr/bin/env python3
"""Compare Rau with edits independently performed in Hancom from a shared source.

This is separate from compare_diagnostic_exports: the two post-edit HWPX files
are expected to differ, but both are hash-pinned and checked against the recipe.
"""

import argparse
import copy
import hashlib
import json
from pathlib import Path
import sys
import xml.etree.ElementTree as ET
from zipfile import ZipFile

from compare_diagnostic_exports import pdf_layout, sha256, svg_lines

NS = {"hp": "http://www.hancom.co.kr/hwpml/2011/paragraph",
      "hh": "http://www.hancom.co.kr/hwpml/2011/head",
      "hc": "http://www.hancom.co.kr/hwpml/2011/core"}
RECIPES = {"body-mixed-text", "body-paragraph-spacing", "cell-mixed-text",
           "cell-empty", "cell-fit-width", "cell-paragraph-spacing"}
CELL_RECIPES = {"cell-empty", "cell-mixed-text", "cell-paragraph-spacing"}
GLYPH_RECIPES = {"body-mixed-text", "cell-mixed-text", "cell-paragraph-spacing"}


def body_recipe_properties(path, target_paragraph=1, paragraph_count=3):
    """Read covered body-image properties, including its Unicode text offset."""
    with ZipFile(path) as package:
        version = ET.fromstring(package.read("version.xml")).get("xmlVersion")
        if version not in ("1.4", "1.5"):
            raise ValueError(f"Unverified margin-unit version {version}: {path}")
        section = ET.fromstring(package.read("Contents/section0.xml"))
        paragraphs = section.findall("hp:p", NS)
        # XML whitespace is not document text. Read only explicit text elements.
        text = ["".join(t.text or "" for t in p.findall(".//hp:t", NS)) for p in paragraphs]
        pictures = section.findall(".//hp:pic", NS)
        if not pictures:
            return {"text": text, "imageCount": 0}
        if len(paragraphs) != paragraph_count or len(pictures) != 1 or paragraphs[target_paragraph].find(".//hp:pic", NS) is None:
            raise ValueError(f"Expected one picture in body paragraph {target_paragraph}: {path}")
        picture = pictures[0]
        offset = 0
        for element in paragraphs[target_paragraph].iter():
            if element is picture:
                break
            if element.tag == f"{{{NS['hp']}}}t":
                offset += len(element.text or "")
        size, position = picture.find("hp:sz", NS), picture.find("hp:pos", NS)
        resource = picture.find(".//hc:img", NS).get("binaryItemIDRef")
        resources = [name for name in package.namelist()
                     if name.startswith("BinData/") and Path(name).stem == resource]
        if len(resources) != 1:
            raise ValueError("Ambiguous picture resource")
        header = ET.fromstring(package.read("Contents/header.xml"))
        style_id = paragraphs[target_paragraph].get("paraPrIDRef")
        style = header.find(f".//hh:paraPr[@id='{style_id}']", NS)
        case = style.find("hp:switch/hp:case", NS)
        if case is None or not any(value.endswith("/HwpUnitChar") for value in case.attrib.values()):
            raise ValueError("Expected a HwpUnitChar margin case")
        margin = case.find("hh:margin", NS)
        line = case.find("hh:lineSpacing", NS)
        if line.get("type") != "PERCENT":
            raise ValueError("Expected percentage line spacing")
        return {"text": text, "imageCount": 1, "logicalOffset": offset,
                "widthHu": int(size.get("width")), "heightHu": int(size.get("height")),
                "placement": "inline" if position.get("treatAsChar") == "1" else "floating",
                "spacingBeforePt": int(margin.find("hc:prev", NS).get("value")) / 100,
                "spacingAfterPt": int(margin.find("hc:next", NS).get("value")) / 100,
                "lineSpacingPercent": int(line.get("value")),
                "imageSha256": hashlib.sha256(package.read(resources[0])).hexdigest()}


def cell_recipe_properties(path, allow_text=False):
    """Covered semantics for one inline image in A1 of an unmerged 2x2 table."""
    with ZipFile(path) as package:
        section = ET.fromstring(package.read("Contents/section0.xml"))
        tables = section.findall(".//hp:tbl", NS)
        if len(tables) != 1 or (not allow_text and any(t.text for t in section.findall(".//hp:t", NS))):
            raise ValueError("Expected one empty table without document text")
        table = tables[0]
        table_nodes = set(table.iter())
        if any(t.text for t in section.findall(".//hp:t", NS) if t not in table_nodes):
            raise ValueError("Unexpected text outside the table")
        header = ET.fromstring(package.read("Contents/header.xml"))
        version = ET.fromstring(package.read("version.xml")).get("xmlVersion")
        if version not in ("1.4", "1.5"):
            raise ValueError("Unverified cell paragraph margin-unit version")
        cells = table.findall("hp:tr/hp:tc", NS)
        if table.get("rowCnt") != "2" or table.get("colCnt") != "2" or len(cells) != 4:
            raise ValueError("Expected an unmerged 2x2 table")
        geometry = []
        picture_location = None
        picture_paragraph = None
        for cell in cells:
            address = cell.find("hp:cellAddr", NS)
            span = cell.find("hp:cellSpan", NS)
            if span.attrib != {"colSpan": "1", "rowSpan": "1"}:
                raise ValueError("Unexpected merged cell")
            paragraphs = cell.findall("hp:subList/hp:p", NS)
            if len(paragraphs) != 1:
                raise ValueError("Expected one paragraph per cell")
            if paragraphs[0].findall(".//hp:pic", NS):
                picture_location = [int(address.get("rowAddr")), int(address.get("colAddr")), 0]
                picture_paragraph = paragraphs[0]
            sublist = cell.find("hp:subList", NS)
            style = header.find(f".//hh:paraPr[@id='{paragraphs[0].get('paraPrIDRef')}']", NS)
            unit_case = style.find("hp:switch/hp:case", NS)
            if unit_case is None or not any(v.endswith("/HwpUnitChar") for v in unit_case.attrib.values()):
                raise ValueError("Expected a HwpUnitChar cell paragraph margin case")
            formatting = {"alignment": style.find("hh:align", NS).attrib,
                          "margins": {e.tag: e.attrib for e in unit_case.find("hh:margin", NS)},
                          "lineSpacing": unit_case.find("hh:lineSpacing", NS).attrib}
            geometry.append({"address": address.attrib, "span": span.attrib,
                             "size": cell.find("hp:cellSz", NS).attrib,
                             "margin": cell.find("hp:cellMargin", NS).attrib,
                             "hasMargin": cell.get("hasMargin"),
                             "text": "".join(t.text or "" for t in paragraphs[0].findall(".//hp:t", NS)),
                             "paragraphFormatting": formatting,
                             "flow": {key: sublist.get(key) for key in ("textDirection", "lineWrap", "vertAlign")}})
        geometry.sort(key=lambda c: (int(c["address"]["rowAddr"]), int(c["address"]["colAddr"])))
        if [(c["address"]["rowAddr"], c["address"]["colAddr"]) for c in geometry] != [("0", "0"), ("0", "1"), ("1", "0"), ("1", "1")]:
            raise ValueError("Duplicate or missing cell address")
        pictures = section.findall(".//hp:pic", NS)
        result = {"cells": geometry, "tableWidthHu": int(table.find("hp:sz", NS).get("width")),
                  "tablePosition": table.find("hp:pos", NS).attrib, "imageCount": len(pictures)}
        if not pictures:
            return result
        if len(pictures) != 1 or picture_location != [0, 0, 0]:
            raise ValueError("Expected one image in the first paragraph of cell A1")
        picture = pictures[0]
        offset = 0
        for element in picture_paragraph.iter():
            if element is picture:
                break
            if element.tag == f"{{{NS['hp']}}}t":
                offset += len(element.text or "")
        resource = picture.find(".//hc:img", NS).get("binaryItemIDRef")
        resources = [name for name in package.namelist()
                     if name.startswith("BinData/") and Path(name).stem == resource]
        if len(resources) != 1:
            raise ValueError("Ambiguous picture resource")
        size, position = picture.find("hp:sz", NS), picture.find("hp:pos", NS)
        result.update(logicalOffset=offset, widthHu=int(size.get("width")), heightHu=int(size.get("height")),
                      placement="inline" if position.get("treatAsChar") == "1" else "floating",
                      imageSha256=hashlib.sha256(package.read(resources[0])).hexdigest())
        return result


def validate_capture(reference_root, case):
    if case["id"] not in {"body-paragraph-spacing", "body-mixed-text"} | CELL_RECIPES:
        raise ValueError("Independent recipe validation does not support this recipe yet")
    directory = reference_root / case["id"]
    required = {"source.hwpx", "rau-edited.hwpx", "edited.hwpx", "hancom-independent.pdf"}
    if set(case["filesSha256"]) != required:
        raise ValueError("Missing or unexpected captured files")
    for name, digest in case["filesSha256"].items():
        if sha256(directory / name) != digest:
            raise ValueError(f"Captured file hash changed: {case['id']}/{name}")
    if case["id"] in CELL_RECIPES:
        mixed_cell = case["id"] == "cell-mixed-text"
        spacing_cell = case["id"] == "cell-paragraph-spacing"
        has_text = mixed_cell or spacing_cell
        source = cell_recipe_properties(directory / "source.hwpx", allow_text=has_text)
        recipe = case["recipe"]
        if source["imageCount"] != 0 or any(recipe[k] != 0 for k in ("targetRow", "targetColumn", "targetParagraph")):
            raise ValueError("Expected an empty source and insertion into cell A1")
        if recipe["logicalOffset"] != (10 if mixed_cell else 0):
            raise ValueError("Unsupported cell insertion location")
        if has_text and (not source["cells"][0]["text"] or any(c["text"] for c in source["cells"][1:])):
            raise ValueError("Expected source text only in cell A1")
        # Source cells can reference the same paragraph style. Copy each cell
        # independently so changing A1's expected style cannot change its peers.
        expected = {**source, "cells": [copy.deepcopy(cell) for cell in source["cells"]]}
        if spacing_cell:
            if (recipe["spacingBeforePt"], recipe["spacingAfterPt"], recipe["lineSpacingPercent"]) != (6, 3, 160):
                raise ValueError("Unsupported cell paragraph spacing recipe")
            formatting = expected["cells"][0]["paragraphFormatting"]
            for tag, key in (("prev", "spacingBeforePt"), ("next", "spacingAfterPt")):
                formatting["margins"][f"{{{NS['hc']}}}{tag}"]["value"] = str(recipe[key] * 100)
            formatting["lineSpacing"]["type"] = "PERCENT"
            formatting["lineSpacing"]["value"] = str(recipe["lineSpacingPercent"])
        for name in ("rau-edited.hwpx", "edited.hwpx"):
            properties = cell_recipe_properties(directory / name, allow_text=has_text)
            for key in ("cells", "tableWidthHu", "tablePosition"):
                if properties[key] != expected[key]:
                    raise ValueError(f"Independent edit changed covered table properties: {name}: {key}")
            for key in ("logicalOffset", "widthHu", "heightHu", "placement", "imageSha256"):
                if properties.get(key) != recipe[key]:
                    raise ValueError(f"Recipe mismatch in {name}: {key}")
        return
    mixed = case["id"] == "body-mixed-text"
    target, count, offset = (0, 1, 10) if mixed else (1, 3, 0)
    source = body_recipe_properties(directory / "source.hwpx", target, count)
    if source["imageCount"] != 0 or len(source["text"]) != count or (not mixed and source["text"][1] != ""):
        raise ValueError("Unexpected pre-edit body paragraph structure")
    recipe = case["recipe"]
    if recipe["targetParagraph"] != target or recipe["logicalOffset"] != offset:
        raise ValueError("Unsupported insertion location")
    for name in ("rau-edited.hwpx", "edited.hwpx"):
        properties = body_recipe_properties(directory / name, target, count)
        if properties["text"] != source["text"]:
            raise ValueError(f"Independent edit changed source text: {name}")
        for key in ("logicalOffset", "widthHu", "heightHu", "placement", "spacingBeforePt",
                    "spacingAfterPt", "lineSpacingPercent", "imageSha256"):
            if properties[key] != recipe[key]:
                raise ValueError(f"Recipe mismatch in {name}: {key}")


def empty_table_deltas(page, controls, dpi):
    """Compare all four cells with the six border centerlines in this PDF recipe."""
    axes = {"x": set(), "y": set()}
    for drawing in page.get_drawings():
        for item in drawing["items"]:
            if item[0] != "l":
                raise ValueError("Unexpected non-line drawing in the table recipe")
            a, b = item[1:]
            if abs(a.x - b.x) < 0.001:
                axes["x"].add(a.x)
            elif abs(a.y - b.y) < 0.001:
                axes["y"].add(a.y)
            else:
                raise ValueError("Unexpected diagonal table border")
    if any(len(values) != 3 for values in axes.values()):
        raise ValueError("Expected exactly three horizontal and three vertical borders")
    tables = [c for c in controls if c["type"] == "table"]
    if len(tables) != 1 or len(tables[0]["cells"]) != 4:
        raise ValueError("Expected one rendered table with four cells")
    xs, ys = sorted(axes["x"]), sorted(axes["y"])
    deltas, seen = [], set()
    for cell in tables[0]["cells"]:
        row, col = cell["row"], cell["col"]
        if (row, col) in seen or row not in (0, 1) or col not in (0, 1) or cell["rowSpan"] != 1 or cell["colSpan"] != 1:
            raise ValueError("Unexpected rendered cell address or span")
        seen.add((row, col))
        official = (xs[col], ys[row], xs[col+1]-xs[col], ys[row+1]-ys[row])
        deltas.append({"row": row, "col": col, "deltasPt": {
            key: value - cell[key] * 72 / dpi for key, value in zip(("x", "y", "w", "h"), official)}})
    return deltas


def mixed_body_glyph_deltas(page, svg_path, dpi):
    """Compare each visible character origin, not just the start of a line.

    This recipe emits one untransformed SVG text element per character. Refuse
    unsupported text shapes instead of estimating their internal glyph advances.
    """
    rau = []
    for element in ET.parse(svg_path).getroot().iter():
        if "transform" in element.attrib and element.tag.endswith(("}g", "}text")):
            raise ValueError("Transformed SVG glyphs are not supported")
        if element.tag.endswith("}text"):
            text = "".join(element.itertext())
            if not text.strip():
                continue
            if len(text) != 1 or list(element):
                raise ValueError("Expected one plain character per SVG text element")
            rau.append((text, float(element.get("x")) * 72 / dpi, float(element.get("y")) * 72 / dpi))
    official = []
    for block in page.get_text("rawdict")["blocks"]:
        if block["type"] != 0:
            continue
        for line in block["lines"]:
            if line["dir"] != (1.0, 0.0):
                raise ValueError("Non-horizontal PDF glyphs are not supported")
            for span in line["spans"]:
                official.extend((c["c"], *c["origin"]) for c in span["chars"] if c["c"].strip())
    rau.sort(key=lambda c: (c[2], c[1]))
    official.sort(key=lambda c: (c[2], c[1]))
    if not rau or [c[0] for c in rau] != [c[0] for c in official]:
        raise ValueError("Visible glyph sequence differs from Hancom")
    return [{"index": index, "text": a[0], "dxPt": b[1]-a[1], "dyPt": b[2]-a[2]}
            for index, (a, b) in enumerate(zip(rau, official))]


def compare(root, reference_root, mode="parallel-edit"):
    import pymupdf

    capture = json.loads((reference_root / "capture.json").read_text())
    manifest = json.loads((root / "manifest.json").read_text())
    if capture.get("comparison") != "independent-hancom-edit" or manifest.get("schemaVersion") != 2:
        raise ValueError("Expected independent capture and version-2 Rau layout manifest")
    if mode not in ("parallel-edit", "hancom-import"):
        raise ValueError("Unsupported comparison mode")
    if manifest.get("fontMetricsPolicy") != capture["fontMetricsPolicy"]:
        raise ValueError("Font metric policy differs from the capture environment")
    if not capture.get("cases"):
        raise ValueError("No independent captures")
    if len({c["id"] for c in capture["cases"]}) != len(capture["cases"]):
        raise ValueError("Duplicate independent capture recipe")
    tolerance = capture["positionTolerancePt"]
    if tolerance != 0.5 or manifest["acceptance"]["positionTolerancePt"] != tolerance:
        raise ValueError("Independent acceptance tolerance must remain 0.5 pt")
    dpi = manifest["layoutDpi"]
    if not isinstance(dpi, (int, float)) or not 0 < dpi <= 1200:
        raise ValueError("Invalid layout DPI")
    results = []
    for captured in capture["cases"]:
        validate_capture(reference_root, captured)
        matches = [c for c in manifest["cases"] if c["id"] == captured["id"]]
        if len(matches) != 1:
            raise ValueError("Expected exactly one matching rendered recipe")
        case = matches[0]
        directory = root / case["id"]
        expected_name = "rau-edited.hwpx" if mode == "parallel-edit" else "edited.hwpx"
        if sha256(directory / "edited.hwpx") != captured["filesSha256"][expected_name]:
            raise ValueError("Rendered input changed; capture a new independently verified case")
        if mode == "parallel-edit" and sha256(directory / "source.hwpx") != captured["filesSha256"]["source.hwpx"]:
            raise ValueError("Rau and Hancom did not start with the same source")
        if not case["localRoundtrip"]["exactLayoutMatch"] or case["localRoundtrip"]["cycles"] != 3:
            raise ValueError("Three exact-layout reopen cycles are required")
        reopened = case.get("reopenedLayouts", [])
        if len(reopened) != 3 or any(layout != case["editedLiveLayout"] for layout in reopened):
            raise ValueError("Reopened layout evidence disagrees with the roundtrip flag")
        with pymupdf.open(reference_root / case["id"] / "hancom-independent.pdf") as doc:
            same_pages = doc.page_count == case["editedLiveLayout"]["pageCount"] == 1
            if not same_pages:
                results.append({"id": case["id"], "status": "fail", "samePageCount": False})
                continue
            official_lines = pdf_layout(doc[0])
            rau_lines = svg_lines(directory / "edited-live-page-1.svg", dpi)
            same_lines = [x["text"] for x in official_lines] == [x["text"] for x in rau_lines]
            deltas = [{"text": a["text"], "dxPt": b["x"] - a["x"], "dyPt": b["y"] - a["y"]}
                      for a, b in zip(rau_lines, official_lines)] if same_lines else []
            images = [c for c in case["editedLiveLayout"]["pages"][0]["controls"] if c["type"] == "image"]
            official_images = doc[0].get_image_info()
            if len(images) != 1 or len(official_images) != 1:
                raise ValueError("Expected exactly one image in each rendering")
            image = images[0]
            x0, y0, x1, y1 = official_images[0]["bbox"]
            image_deltas = dict(zip(("x", "y", "w", "h"),
                [value - image[key] * 72 / dpi for value, key in zip((x0, y0, x1-x0, y1-y0), ("x", "y", "w", "h"))]))
            passed = same_lines and all(abs(v) <= tolerance for v in image_deltas.values())
            passed = passed and all(abs(d[k]) <= tolerance for d in deltas for k in ("dxPt", "dyPt"))
            cell_deltas = empty_table_deltas(doc[0], case["editedLiveLayout"]["pages"][0]["controls"], dpi) if case["id"] in CELL_RECIPES else []
            passed = passed and all(abs(value) <= tolerance for cell in cell_deltas for value in cell["deltasPt"].values())
            glyph_deltas = mixed_body_glyph_deltas(doc[0], directory / "edited-live-page-1.svg", dpi) if case["id"] in GLYPH_RECIPES else []
            passed = passed and all(abs(d[key]) <= tolerance for d in glyph_deltas for key in ("dxPt", "dyPt"))
            results.append({"id": case["id"], "status": "pass" if passed else "fail",
                            "samePageCount": same_pages, "sameNonWhitespaceLineBreaks": same_lines,
                            "imageDeltasPt": image_deltas, "lineStartDeltas": deltas,
                            "cellDeltas": cell_deltas,
                            "glyphOriginDeltas": glyph_deltas,
                            "rauLines": rau_lines, "hancomLines": official_lines,
                            "capturedFilesSha256": captured["filesSha256"]})
    return {"schemaVersion": 1, "comparison": "independent-hancom-edit", "mode": mode,
            "fullParityVerified": False, "positionTolerancePt": tolerance,
            "capturedRecipeCount": len(results),
            "pendingRecipes": sorted(RECIPES - {case["id"] for case in capture["cases"]}),
            "limitations": ["Only captured recipes are checked", "Recipe checks cover selected properties, not every XML property", "Visible glyph origins are gated only for body-mixed-text, cell-mixed-text and cell-paragraph-spacing; whitespace glyphs, glyph outlines and complete typography are not gated"],
            "cases": results}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("run_directory", type=Path)
    parser.add_argument("--reference-directory", type=Path, required=True)
    parser.add_argument("--mode", choices=("parallel-edit", "hancom-import"), default="parallel-edit")
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    if args.output.exists():
        parser.error("Output already exists; retain prior comparison evidence")
    report = compare(args.run_directory, args.reference_directory, args.mode)
    args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
    for case in report["cases"]:
        print(f"{case['id']}: {case['status']}")
    return 0 if all(case["status"] == "pass" for case in report["cases"]) else 1


if __name__ == "__main__":
    sys.exit(main())
