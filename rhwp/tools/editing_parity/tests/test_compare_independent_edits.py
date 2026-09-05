import copy
import json
from pathlib import Path
import shutil
import sys
import tempfile
import unittest
from unittest.mock import patch
import xml.etree.ElementTree as ET
from zipfile import ZipFile

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from compare_diagnostic_exports import pdf_layout, sha256
from compare_independent_edits import body_recipe_properties, cell_recipe_properties, empty_table_deltas, mixed_body_glyph_deltas, compare, validate_capture


class IndependentEditComparisonTests(unittest.TestCase):
    fixture = Path(__file__).resolve().parents[3] / "tests/fixtures/editing_parity/mac-hancom-12.30.0-independent"

    def setUp(self):
        import pymupdf

        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.reference = self.root / "reference"
        shutil.copytree(self.fixture, self.reference)
        self.capture = json.loads((self.reference / "capture.json").read_text())
        self.case = self.capture["cases"][0]
        # These comparator unit tests exercise one recipe at a time. The real
        # engine runs compare every case in the complete pinned capture.
        self.capture["cases"] = [self.case]
        (self.reference / "capture.json").write_text(json.dumps(self.capture))
        self.run = self.root / "run"
        directory = self.run / self.case["id"]
        directory.mkdir(parents=True)
        for source, dest in [("source.hwpx", "source.hwpx"), ("rau-edited.hwpx", "edited.hwpx")]:
            shutil.copyfile(self.reference / self.case["id"] / source, directory / dest)
        # Construct matching geometry to unit-test the comparator. This is not
        # an engine rendering and must never become a parity reference.
        with pymupdf.open(self.reference / self.case["id"] / "hancom-independent.pdf") as pdf:
            x0, y0, x1, y1 = pdf[0].get_image_info()[0]["bbox"]
            svg = ET.Element("svg", {"xmlns": "http://www.w3.org/2000/svg"})
            for line in pdf_layout(pdf[0]):
                ET.SubElement(svg, "text", {"x": str(line["x"] * 4/3), "y": str(line["y"] * 4/3)}).text = line["text"]
        self.svg = directory / "edited-live-page-1.svg"
        ET.ElementTree(svg).write(self.svg, encoding="utf-8")
        layout = {"pageCount": 1, "pages": [{"controls": [{"type": "image", "x": x0*4/3,
                  "y": y0*4/3, "w": (x1-x0)*4/3, "h": (y1-y0)*4/3}]}]}
        self.manifest = {"schemaVersion": 2, "layoutDpi": 96, "fontMetricsPolicy": "HcrDeclared",
                         "acceptance": {"positionTolerancePt": 0.5},
                         "cases": [{"id": self.case["id"], "editedLiveLayout": layout,
                                    "reopenedLayouts": [copy.deepcopy(layout) for _ in range(3)],
                                    "localRoundtrip": {"cycles": 3, "exactLayoutMatch": True}}]}
        self.write_manifest()

    def write_manifest(self):
        (self.run / "manifest.json").write_text(json.dumps(self.manifest))

    def test_capture_hashes_and_independently_saved_recipe_match(self):
        validate_capture(self.reference, self.case)
        self.assertNotEqual(self.case["filesSha256"]["rau-edited.hwpx"], self.case["filesSha256"]["edited.hwpx"])
        for name in ("rau-edited.hwpx", "edited.hwpx"):
            properties = body_recipe_properties(self.reference / self.case["id"] / name)
            self.assertEqual(properties["spacingBeforePt"], 6)
            self.assertEqual(properties["spacingAfterPt"], 3)
            self.assertEqual(properties["widthHu"], 18000)

    def test_matching_geometry_does_not_claim_remaining_recipes_complete(self):
        report = compare(self.run, self.reference)
        self.assertEqual(report["cases"][0]["status"], "pass")
        self.assertFalse(report["fullParityVerified"])
        self.assertEqual(len(report["pendingRecipes"]), 5)

    def test_changed_rendered_input_is_rejected_before_opening_pdf(self):
        (self.run / self.case["id"] / "edited.hwpx").write_bytes(b"changed")
        with patch("pymupdf.open") as open_pdf:
            with self.assertRaisesRegex(ValueError, "Rendered input changed"):
                compare(self.run, self.reference)
            open_pdf.assert_not_called()

    def test_changed_shared_source_is_rejected(self):
        (self.run / self.case["id"] / "source.hwpx").write_bytes(b"different source")
        with self.assertRaisesRegex(ValueError, "same source"):
            compare(self.run, self.reference)

    def test_changed_capture_and_wrong_recipe_are_rejected(self):
        changed = copy.deepcopy(self.case)
        changed["recipe"]["heightHu"] = 9001
        with self.assertRaisesRegex(ValueError, "Recipe mismatch"):
            validate_capture(self.reference, changed)
        (self.reference / self.case["id"] / "hancom-independent.pdf").write_bytes(b"different PDF")
        with self.assertRaisesRegex(ValueError, "hash changed"):
            validate_capture(self.reference, self.case)

    def test_geometry_mismatch_fails_without_changing_tolerance(self):
        tree = ET.parse(self.svg)
        line = list(tree.getroot())[0]
        line.set("y", str(float(line.get("y")) + 4))
        tree.write(self.svg, encoding="utf-8")
        self.assertEqual(compare(self.run, self.reference)["cases"][0]["status"], "fail")

    def test_roundtrip_flag_cannot_hide_changed_layout(self):
        self.manifest["cases"][0]["reopenedLayouts"][1]["pageCount"] = 2
        self.write_manifest()
        with self.assertRaisesRegex(ValueError, "roundtrip flag"):
            compare(self.run, self.reference)

    def test_import_mode_requires_the_hancom_file(self):
        with self.assertRaisesRegex(ValueError, "Rendered input changed"):
            compare(self.run, self.reference, "hancom-import")
        shutil.copyfile(self.reference / self.case["id"] / "edited.hwpx", self.run / self.case["id"] / "edited.hwpx")
        self.assertEqual(compare(self.run, self.reference, "hancom-import")["cases"][0]["status"], "pass")

    def test_duplicate_capture_cannot_inflate_coverage(self):
        self.capture["cases"].append(copy.deepcopy(self.case))
        (self.reference / "capture.json").write_text(json.dumps(self.capture))
        with self.assertRaisesRegex(ValueError, "Duplicate independent"):
            compare(self.run, self.reference)

    def test_body_mixed_capture_checks_exact_unicode_offset(self):
        capture = json.loads((self.fixture / "capture.json").read_text())
        case = next(c for c in capture["cases"] if c["id"] == "body-mixed-text")
        validate_capture(self.reference, case)
        for name in ("rau-edited.hwpx", "edited.hwpx"):
            properties = body_recipe_properties(self.reference / case["id"] / name, 0, 1)
            self.assertEqual(properties["logicalOffset"], 10)
            self.assertTrue(properties["text"][0].startswith("그림 앞의 글입니다. Picture"))
        wrong = copy.deepcopy(case)
        wrong["recipe"]["logicalOffset"] = 9
        with self.assertRaisesRegex(ValueError, "insertion location"):
            validate_capture(self.reference, wrong)

    def prepare_mixed_glyph_geometry(self, case_id="body-mixed-text"):
        """Synthetic matching geometry, used only to test acceptance checks."""
        import pymupdf

        capture = json.loads((self.fixture / "capture.json").read_text())
        mixed = next(c for c in capture["cases"] if c["id"] == case_id)
        self.capture["cases"] = [mixed]
        (self.reference / "capture.json").write_text(json.dumps(self.capture))
        directory = self.run / mixed["id"]
        shutil.copytree(self.reference / mixed["id"], directory)
        shutil.copyfile(directory / "rau-edited.hwpx", directory / "edited.hwpx")
        svg = ET.Element("svg", {"xmlns": "http://www.w3.org/2000/svg"})
        tables = []
        with pymupdf.open(directory / "hancom-independent.pdf") as pdf:
            for block in pdf[0].get_text("rawdict")["blocks"]:
                if block["type"] != 0:
                    continue
                for line in block["lines"]:
                    for span in line["spans"]:
                        for glyph in span["chars"]:
                            if glyph["c"].strip():
                                x, y = glyph["origin"]
                                ET.SubElement(svg, "text", {"x": str(x*4/3), "y": str(y*4/3)}).text = glyph["c"]
            x0, y0, x1, y1 = pdf[0].get_image_info()[0]["bbox"]
            if case_id in {"cell-mixed-text", "cell-paragraph-spacing"}:
                borders = [item for drawing in pdf[0].get_drawings() for item in drawing["items"]]
                xs = sorted({i[1].x for i in borders if i[1].x == i[2].x})
                ys = sorted({i[1].y for i in borders if i[1].y == i[2].y})
                tables = [{"type": "table", "cells": [
                    {"row": r, "col": c, "rowSpan": 1, "colSpan": 1,
                     "x": xs[c]*4/3, "y": ys[r]*4/3,
                     "w": (xs[c+1]-xs[c])*4/3, "h": (ys[r+1]-ys[r])*4/3}
                    for r in range(2) for c in range(2)]}]
        self.svg = directory / "edited-live-page-1.svg"
        ET.ElementTree(svg).write(self.svg, encoding="utf-8")
        case = self.manifest["cases"][0]
        case["id"] = mixed["id"]
        case["editedLiveLayout"]["pages"][0]["controls"] = [
            {"type": "image", "x": x0*4/3, "y": y0*4/3,
             "w": (x1-x0)*4/3, "h": (y1-y0)*4/3}] + tables
        case["reopenedLayouts"] = [copy.deepcopy(case["editedLiveLayout"]) for _ in range(3)]
        self.write_manifest()

    def test_last_glyph_drift_fails_even_when_image_and_line_starts_match(self):
        self.prepare_mixed_glyph_geometry()
        result = compare(self.run, self.reference)["cases"][0]
        self.assertEqual(result["status"], "pass")
        self.assertEqual(len(result["glyphOriginDeltas"]), 55)
        tree = ET.parse(self.svg)
        last = list(tree.getroot())[-1]
        last.set("x", str(float(last.get("x")) - 0.58*4/3))
        tree.write(self.svg, encoding="utf-8")
        result = compare(self.run, self.reference)["cases"][0]
        self.assertEqual(result["status"], "fail")
        self.assertTrue(result["sameNonWhitespaceLineBreaks"])
        self.assertTrue(all(abs(v) < 1e-10 for v in result["imageDeltasPt"].values()))
        self.assertTrue(all(abs(d[k]) < 1e-10 for d in result["lineStartDeltas"] for k in ("dxPt", "dyPt")))
        self.assertAlmostEqual(result["glyphOriginDeltas"][-1]["dxPt"], 0.58)

    def test_glyph_comparison_rejects_unsupported_svg_and_changed_characters(self):
        import pymupdf

        self.prepare_mixed_glyph_geometry()
        original = self.svg.read_bytes()
        with pymupdf.open(self.fixture / "body-mixed-text/hancom-independent.pdf") as pdf:
            for mutation, message in [
                (lambda e: e.set("transform", "translate(1,0)"), "Transformed"),
                (lambda e: setattr(e, "text", "가나"), "one plain character"),
                (lambda e: ET.SubElement(e, "tspan"), "one plain character"),
                (lambda e: setattr(e, "text", "X"), "glyph sequence"),
            ]:
                with self.subTest(message=message):
                    tree = ET.ElementTree(ET.fromstring(original))
                    mutation(list(tree.getroot())[0])
                    tree.write(self.svg, encoding="utf-8")
                    with self.assertRaisesRegex(ValueError, message):
                        mixed_body_glyph_deltas(pdf[0], self.svg, 96)

    def test_mixed_cell_glyph_drift_fails_with_matching_table_and_line_starts(self):
        self.prepare_mixed_glyph_geometry("cell-mixed-text")
        result = compare(self.run, self.reference)["cases"][0]
        self.assertEqual(result["status"], "pass")
        self.assertEqual(len(result["glyphOriginDeltas"]), 55)
        self.assertEqual(len(result["cellDeltas"]), 4)
        tree = ET.parse(self.svg)
        glyph = list(tree.getroot())[39]
        self.assertEqual(glyph.text, "p")
        glyph.set("x", str(float(glyph.get("x")) + 0.56*4/3))
        tree.write(self.svg, encoding="utf-8")
        result = compare(self.run, self.reference)["cases"][0]
        self.assertEqual(result["status"], "fail")
        self.assertTrue(result["sameNonWhitespaceLineBreaks"])
        self.assertTrue(all(abs(v) < 1e-10 for cell in result["cellDeltas"] for v in cell["deltasPt"].values()))
        self.assertTrue(all(abs(d[k]) < 1e-10 for d in result["lineStartDeltas"] for k in ("dxPt", "dyPt")))
        self.assertAlmostEqual(result["glyphOriginDeltas"][39]["dxPt"], -0.56)

    def test_moving_picture_one_character_is_rejected_even_with_same_text(self):
        capture = json.loads((self.fixture / "capture.json").read_text())
        case = next(c for c in capture["cases"] if c["id"] == "body-mixed-text")
        native = self.reference / case["id"] / "edited.hwpx"
        original = body_recipe_properties(native, 0, 1)
        # Synthetic corruption in the temporary test copy, never a new oracle.
        with ZipFile(native) as package:
            entries = {name: package.read(name) for name in package.namelist()}
        section = ET.fromstring(entries["Contents/section0.xml"])
        texts = section.findall(".//{http://www.hancom.co.kr/hwpml/2011/paragraph}t")
        texts[1].text = texts[0].text[-1] + texts[1].text
        texts[0].text = texts[0].text[:-1]
        entries["Contents/section0.xml"] = ET.tostring(section)
        with ZipFile(native, "w") as package:
            for name, data in entries.items():
                package.writestr(name, data)
        changed = body_recipe_properties(native, 0, 1)
        self.assertEqual(changed["text"], original["text"])
        self.assertEqual(changed["logicalOffset"], 9)
        # Bypass only this synthetic file's hash check to exercise the semantic
        # offset check. The checked-in capture digest remains untouched.
        case["filesSha256"]["edited.hwpx"] = sha256(native)
        with self.assertRaisesRegex(ValueError, "logicalOffset"):
            validate_capture(self.reference, case)

    def test_cell_paragraph_spacing_capture_changes_only_a1(self):
        capture = json.loads((self.fixture / "capture.json").read_text())
        case = next(c for c in capture["cases"] if c["id"] == "cell-paragraph-spacing")
        validate_capture(self.reference, case)
        directory = self.reference / case["id"]
        source = cell_recipe_properties(directory / "source.hwpx", allow_text=True)
        for name in ("rau-edited.hwpx", "edited.hwpx"):
            properties = cell_recipe_properties(directory / name, allow_text=True)
            self.assertEqual(properties["logicalOffset"], 0)
            self.assertEqual(properties["cells"][1:], source["cells"][1:])
            style = properties["cells"][0]["paragraphFormatting"]
            for tag, value in (("prev", "600"), ("next", "300")):
                self.assertEqual(style["margins"][f"{{http://www.hancom.co.kr/hwpml/2011/core}}{tag}"]["value"], value)
            self.assertEqual(style["lineSpacing"]["value"], "160")
        for key in ("spacingBeforePt", "spacingAfterPt", "lineSpacingPercent"):
            wrong = copy.deepcopy(case)
            wrong["recipe"][key] += 1
            with self.assertRaisesRegex(ValueError, "spacing recipe"):
                validate_capture(self.reference, wrong)

    def test_cell_spacing_rejects_unrequested_margin_changes(self):
        capture = json.loads((self.fixture / "capture.json").read_text())
        captured = next(c for c in capture["cases"] if c["id"] == "cell-paragraph-spacing")
        native = self.reference / captured["id"] / "edited.hwpx"
        ns = {"hp": "http://www.hancom.co.kr/hwpml/2011/paragraph",
              "hh": "http://www.hancom.co.kr/hwpml/2011/head",
              "hc": "http://www.hancom.co.kr/hwpml/2011/core"}
        with ZipFile(native) as package:
            original = {name: package.read(name) for name in package.namelist()}
        for cell_index, margin in ((0, "left"), (0, "prev"), (1, "prev")):
            with self.subTest(cell=cell_index, margin=margin):
                entries = dict(original)
                section = ET.fromstring(entries["Contents/section0.xml"])
                paragraph = section.findall(".//hp:tc", ns)[cell_index].find("hp:subList/hp:p", ns)
                header = ET.fromstring(entries["Contents/header.xml"])
                header.find(f".//hh:paraPr[@id='{paragraph.get('paraPrIDRef')}']/hp:switch/hp:case/hh:margin/hc:{margin}", ns).set("value", "123")
                entries["Contents/header.xml"] = ET.tostring(header)
                with ZipFile(native, "w") as package:
                    for name, data in entries.items():
                        package.writestr(name, data)
                case = copy.deepcopy(captured)
                case["filesSha256"]["edited.hwpx"] = sha256(native)
                with self.assertRaisesRegex(ValueError, "table properties"):
                    validate_capture(self.reference, case)

    def test_cell_spacing_gates_glyphs_and_all_cell_boundaries(self):
        self.prepare_mixed_glyph_geometry("cell-paragraph-spacing")
        result = compare(self.run, self.reference)["cases"][0]
        self.assertEqual(result["status"], "pass")
        self.assertEqual(len(result["glyphOriginDeltas"]), 55)
        self.assertEqual(len(result["cellDeltas"]), 4)
        original = self.svg.read_bytes()
        tree = ET.parse(self.svg)
        glyph = list(tree.getroot())[-1]
        glyph.set("x", str(float(glyph.get("x")) + 0.56*4/3))
        tree.write(self.svg, encoding="utf-8")
        result = compare(self.run, self.reference)["cases"][0]
        self.assertEqual(result["status"], "fail")
        self.assertTrue(all(abs(v) < 1e-10 for c in result["cellDeltas"] for v in c["deltasPt"].values()))
        self.assertAlmostEqual(result["glyphOriginDeltas"][-1]["dxPt"], -0.56)
        self.svg.write_bytes(original)
        case = self.manifest["cases"][0]
        table = case["editedLiveLayout"]["pages"][0]["controls"][1]
        table["cells"][3]["h"] += 0.56*4/3
        case["reopenedLayouts"] = [copy.deepcopy(case["editedLiveLayout"]) for _ in range(3)]
        self.write_manifest()
        result = compare(self.run, self.reference)["cases"][0]
        self.assertEqual(result["status"], "fail")
        self.assertAlmostEqual(result["cellDeltas"][3]["deltasPt"]["h"], -0.56)
        self.assertTrue(all(abs(d[k]) < 1e-10 for d in result["glyphOriginDeltas"] for k in ("dxPt", "dyPt")))

    def test_independent_empty_cell_capture_preserves_covered_properties(self):
        capture = json.loads((self.fixture / "capture.json").read_text())
        cell = next(c for c in capture["cases"] if c["id"] == "cell-empty")
        validate_capture(self.reference, cell)
        native = cell_recipe_properties(self.reference / "cell-empty/edited.hwpx")
        self.assertEqual(native["imageCount"], 1)
        self.assertEqual(native["widthHu"], 18000)
        wrong = copy.deepcopy(cell)
        wrong["recipe"]["targetColumn"] = 1
        with self.assertRaisesRegex(ValueError, "cell A1"):
            validate_capture(self.reference, wrong)

    def test_independent_mixed_cell_capture_checks_offset_and_source_properties(self):
        capture = json.loads((self.fixture / "capture.json").read_text())
        case = next(c for c in capture["cases"] if c["id"] == "cell-mixed-text")
        validate_capture(self.reference, case)
        source = cell_recipe_properties(self.reference / case["id"] / "source.hwpx", allow_text=True)
        for name in ("rau-edited.hwpx", "edited.hwpx"):
            properties = cell_recipe_properties(self.reference / case["id"] / name, allow_text=True)
            self.assertEqual(properties["logicalOffset"], 10)
            self.assertEqual(properties["cells"], source["cells"])
            self.assertEqual(properties["widthHu"], 18000)
        with self.assertRaisesRegex(ValueError, "empty table"):
            cell_recipe_properties(self.reference / case["id"] / "edited.hwpx")

    def test_mixed_cell_rejects_changed_text_spacing_and_image_ownership(self):
        capture = json.loads((self.fixture / "capture.json").read_text())
        captured = next(c for c in capture["cases"] if c["id"] == "cell-mixed-text")
        native = self.reference / captured["id"] / "edited.hwpx"
        ns = {"hp": "http://www.hancom.co.kr/hwpml/2011/paragraph",
              "hh": "http://www.hancom.co.kr/hwpml/2011/head",
              "hc": "http://www.hancom.co.kr/hwpml/2011/core"}
        with ZipFile(native) as package:
            original = {name: package.read(name) for name in package.namelist()}
        for mutation, message in [("offset", "logicalOffset"), ("text", "table properties"),
                                  ("spacing", "table properties"), ("owner", "cell A1")]:
            with self.subTest(mutation=mutation):
                entries = dict(original)
                section = ET.fromstring(entries["Contents/section0.xml"])
                texts = section.findall(".//hp:t", ns)
                if mutation == "offset":
                    texts[1].text = texts[0].text[-1] + texts[1].text
                    texts[0].text = texts[0].text[:-1]
                elif mutation == "text":
                    texts[0].text += "X"
                elif mutation == "spacing":
                    header = ET.fromstring(entries["Contents/header.xml"])
                    header.find(".//hh:paraPr[@id='0']/hp:switch/hp:case/hh:margin/hc:prev", ns).set("value", "100")
                    entries["Contents/header.xml"] = ET.tostring(header)
                else:
                    cells = section.findall(".//hp:tc", ns)
                    picture = cells[0].find(".//hp:pic", ns)
                    parent = next(e for e in cells[0].iter() if picture in list(e))
                    parent.remove(picture)
                    cells[1].find("hp:subList/hp:p/hp:run", ns).append(picture)
                entries["Contents/section0.xml"] = ET.tostring(section)
                with ZipFile(native, "w") as package:
                    for name, data in entries.items():
                        package.writestr(name, data)
                # Exercise semantics beyond the digest guard, using only a
                # corrupted temporary copy. No pinned reference is rewritten.
                case = copy.deepcopy(captured)
                case["filesSha256"]["edited.hwpx"] = sha256(native)
                with self.assertRaisesRegex(ValueError, message):
                    validate_capture(self.reference, case)

    def test_empty_cell_picture_size_mismatch_is_rejected(self):
        capture = json.loads((self.fixture / "capture.json").read_text())
        cell = next(c for c in capture["cases"] if c["id"] == "cell-empty")
        cell["recipe"]["heightHu"] += 1
        with self.assertRaisesRegex(ValueError, "Recipe mismatch"):
            validate_capture(self.reference, cell)

    def test_empty_table_geometry_checks_every_cell(self):
        import pymupdf

        with pymupdf.open(self.fixture / "cell-empty/hancom-independent.pdf") as pdf:
            lines = [item for d in pdf[0].get_drawings() for item in d["items"]]
            xs = sorted({i[1].x for i in lines if i[1].x == i[2].x})
            ys = sorted({i[1].y for i in lines if i[1].y == i[2].y})
            table = {"type": "table", "cells": [
                {"row": r, "col": c, "rowSpan": 1, "colSpan": 1,
                 "x": xs[c]*4/3, "y": ys[r]*4/3,
                 "w": (xs[c+1]-xs[c])*4/3, "h": (ys[r+1]-ys[r])*4/3}
                for r in range(2) for c in range(2)]}
            deltas = empty_table_deltas(pdf[0], [table], 96)
            self.assertTrue(all(abs(v) < 1e-10 for d in deltas for v in d["deltasPt"].values()))
            captured = json.loads((self.fixture / "capture.json").read_text())
            cell_case = next(c for c in captured["cases"] if c["id"] == "cell-empty")
            self.capture["cases"] = [cell_case]
            (self.reference / "capture.json").write_text(json.dumps(self.capture))
            directory = self.run / "cell-empty"
            shutil.copytree(self.reference / "cell-empty", directory)
            shutil.copyfile(directory / "rau-edited.hwpx", directory / "edited.hwpx")
            (directory / "edited-live-page-1.svg").write_text('<svg xmlns="http://www.w3.org/2000/svg"/>')
            x0, y0, x1, y1 = pdf[0].get_image_info()[0]["bbox"]
            image = {"type": "image", "x": x0*4/3, "y": y0*4/3,
                     "w": (x1-x0)*4/3, "h": (y1-y0)*4/3}
            case = self.manifest["cases"][0]
            case["id"] = "cell-empty"
            case["editedLiveLayout"]["pages"][0]["controls"] = [image, table]
            case["reopenedLayouts"] = [copy.deepcopy(case["editedLiveLayout"]) for _ in range(3)]
            self.write_manifest()
            self.assertEqual(compare(self.run, self.reference)["cases"][0]["status"], "pass")
            table["cells"][3]["h"] += 4
            deltas = empty_table_deltas(pdf[0], [table], 96)
            self.assertAlmostEqual(deltas[3]["deltasPt"]["h"], -3)
            case["reopenedLayouts"] = [copy.deepcopy(case["editedLiveLayout"]) for _ in range(3)]
            self.write_manifest()
            self.assertEqual(compare(self.run, self.reference)["cases"][0]["status"], "fail")
            table["cells"][3]["col"] = 0
            with self.assertRaisesRegex(ValueError, "address or span"):
                empty_table_deltas(pdf[0], [table], 96)


if __name__ == "__main__":
    unittest.main()
