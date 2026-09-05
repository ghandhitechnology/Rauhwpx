from pathlib import Path
import hashlib
import json
import sys
import tempfile
import unittest
import xml.etree.ElementTree as ET
from zipfile import ZipFile
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from compare_diagnostic_exports import compare, group_lines, svg_lines


class DiagnosticExportComparisonTests(unittest.TestCase):
    def test_changed_reference_input_is_not_compared_or_accepted(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / "run"
            ref = Path(directory) / "reference"
            for base, content in [(root, b"new-input"), (ref, b"captured-input")]:
                (base / "example").mkdir(parents=True)
                (base / "example/edited.hwpx").write_bytes(content)
            (ref / "example/hancom-opened-rau.pdf").write_bytes(b"must-not-be-opened")
            (root / "manifest.json").write_text(json.dumps({
                "schemaVersion": 2, "layoutDpi": 96,
                "acceptance": {"positionTolerancePt": 0.5}, "cases": [{"id": "example"}],
            }))
            # No PDF parser is needed or permitted for a mismatched input.
            with patch.dict(sys.modules, {"pymupdf": object()}):
                report = compare(root, ref)
            self.assertEqual(report["cases"][0]["status"], "reference-input-changed")
            self.assertFalse(report["fullParityVerified"])

    def test_pinned_hancom_capture_files_match_recorded_hashes(self):
        fixtures = Path(__file__).resolve().parents[3] / "tests/fixtures/editing_parity"
        for name in ("mac-hancom-12.30.0", "mac-hancom-12.30.0-xml14"):
            with self.subTest(capture=name):
                root = fixtures / name
                capture = json.loads((root / "capture.json").read_text())
                self.assertEqual(len(capture["cases"]), 6)
                self.assertEqual(capture["application"]["build"], "6446")
                self.assertEqual(capture["independentEditReproduction"], "pending")
                self.assertFalse(capture["fullParityVerified"])
                for case in capture["cases"]:
                    for filename, expected in case["filesSha256"].items():
                        actual = hashlib.sha256((root / case["id"] / filename).read_bytes()).hexdigest()
                        self.assertEqual(actual, expected, f"{name}/{case['id']}/{filename}")

    def test_xml14_capture_records_corrected_inputs_without_claiming_full_parity(self):
        root = Path(__file__).resolve().parents[3] / "tests/fixtures/editing_parity/mac-hancom-12.30.0-xml14"
        capture = json.loads((root / "capture.json").read_text())
        self.assertEqual(capture["fontMetricsPolicy"], "HcrDeclared")
        self.assertEqual(hashlib.sha256((root / "grid.png").read_bytes()).hexdigest(),
                         capture["gridSha256"])
        for case in capture["cases"]:
            with ZipFile(root / case["id"] / "edited.hwpx") as package:
                self.assertEqual(ET.fromstring(package.read("version.xml")).get("xmlVersion"), "1.4")
        # This is the immutable capture-time observation, not an expected failure
        # for future renderers. A corrected renderer must pass against these PDFs.
        report = json.loads((root / "initial-comparison.json").read_text())
        self.assertFalse(report["fullParityVerified"])
        self.assertEqual([case["id"] for case in report["cases"] if case["status"] != "pass"],
                         ["cell-paragraph-spacing"])

    def test_justified_spans_form_one_line_in_reading_order(self):
        lines = group_lines([
            {"text": "글입니다", "x": 200, "y": 100},
            {"text": "그림 ", "x": 90, "y": 100.02},
            {"text": "앞의 ", "x": 140, "y": 100},
            {"text": "다음 줄", "x": 90, "y": 116},
        ])
        self.assertEqual([line["text"] for line in lines], ["그림앞의글입니다", "다음줄"])
        self.assertEqual(lines[0]["x"], 90)

    def test_one_character_wrap_difference_is_not_hidden(self):
        a = group_lines([{"text": "text 그", "x": 90, "y": 100},
                         {"text": "림", "x": 90, "y": 116}])
        b = group_lines([{"text": "text", "x": 90, "y": 100},
                         {"text": "그림", "x": 90, "y": 116}])
        self.assertNotEqual([line["text"] for line in a], [line["text"] for line in b])

    def test_svg_baselines_use_points_not_pixels(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "page.svg"
            path.write_text('<svg xmlns="http://www.w3.org/2000/svg"><text x="120" y="160">A</text></svg>')
            self.assertEqual(svg_lines(path, 96), [{"text": "A", "x": 90, "y": 120}])

    def test_transform_cannot_silently_pass_with_wrong_coordinates(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "page.svg"
            path.write_text('<svg xmlns="http://www.w3.org/2000/svg"><g transform="translate(5 10)"><text>A</text></g></svg>')
            with self.assertRaises(ValueError):
                svg_lines(path, 96)


if __name__ == "__main__":
    unittest.main()
