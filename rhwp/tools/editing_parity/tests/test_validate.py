from __future__ import annotations

from copy import deepcopy
from pathlib import Path
import sys
import unittest


TOOL_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(TOOL_ROOT))

import validate  # noqa: E402


class EditingParityManifestTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.repo_root = TOOL_ROOT.parents[2]
        cls.manifest = validate.load_manifest(validate.DEFAULT_MANIFEST)
        cls.pdf_metadata = {}
        for case in cls.manifest["cases"]:
            path = (cls.repo_root / case["oraclePdf"]).resolve()
            producer = (
                "Hancom PDF 1.3.0.550"
                if case["oracleProvenance"] == "hancom"
                else "cairo 1.18.0"
            )
            cls.pdf_metadata[path] = validate.PdfMetadata(
                case["pageCount"], producer, "test"
            )

    def inspect_pdf(self, path: Path) -> validate.PdfMetadata:
        return self.pdf_metadata[path.resolve()]

    def validate(self, data):
        return validate.validate_manifest_data(data, self.repo_root, self.inspect_pdf)

    def test_checked_in_manifest_is_valid(self) -> None:
        result = self.validate(self.manifest)
        self.assertEqual([], result.errors)
        self.assertEqual(50, result.case_count)
        self.assertEqual(695, result.page_count)
        self.assertEqual(validate.CATEGORY_QUOTAS, result.category_counts)
        self.assertEqual({"hancom": 46, "diagnostic": 4}, result.provenance_counts)

    def test_hash_tamper_is_rejected(self) -> None:
        data = deepcopy(self.manifest)
        data["cases"][0]["sourceSha256"] = "0" * 64
        result = self.validate(data)
        self.assertTrue(any("sourceSha256 mismatch" in error for error in result.errors))
        self.assertTrue(any("corpusSha256 mismatch" in error for error in result.errors))

    def test_duplicate_source_content_is_rejected(self) -> None:
        data = deepcopy(self.manifest)
        data["cases"][1]["sourceSha256"] = data["cases"][0]["sourceSha256"]
        data["corpusSha256"] = validate.corpus_sha256(data["cases"])
        result = self.validate(data)
        self.assertTrue(
            any("duplicate sourceSha256" in error for error in result.errors)
        )

    def test_path_escape_is_rejected(self) -> None:
        data = deepcopy(self.manifest)
        data["cases"][0]["source"] = "../outside.hwp"
        data["corpusSha256"] = validate.corpus_sha256(data["cases"])
        result = self.validate(data)
        self.assertTrue(any("contained POSIX path" in error for error in result.errors))

    def test_hancom_pdf_cannot_be_marked_diagnostic(self) -> None:
        data = deepcopy(self.manifest)
        data["cases"][0]["oracleProvenance"] = "diagnostic"
        data["corpusSha256"] = validate.corpus_sha256(data["cases"])
        result = self.validate(data)
        self.assertTrue(
            any("diagnostic provenance cannot use" in error for error in result.errors)
        )

    def test_cairo_pdf_cannot_be_marked_hancom(self) -> None:
        data = deepcopy(self.manifest)
        diagnostic = next(
            case for case in data["cases"] if case["oracleProvenance"] == "diagnostic"
        )
        diagnostic["oracleProvenance"] = "hancom"
        data["corpusSha256"] = validate.corpus_sha256(data["cases"])
        result = self.validate(data)
        self.assertTrue(
            any("hancom provenance requires" in error for error in result.errors)
        )


if __name__ == "__main__":
    unittest.main()
