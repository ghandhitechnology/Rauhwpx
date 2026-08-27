from __future__ import annotations

import json
from pathlib import Path
import sys
import tempfile
import unittest


TOOL_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(TOOL_ROOT))

import mutation_safety_gate as gate  # noqa: E402


CASE = {
    "id": "table-hwpx",
    "category": "table",
    "source": "rhwp/samples/table.hwpx",
}


class MutationSafetyGateTests(unittest.TestCase):
    def test_bug_report_is_a_mutation_failure_not_execution_failure(self) -> None:
        report = {
            "status": "ok",
            "elapsedMs": 12,
            "baseline": {"pages": 1},
            "ops": [{"name": "table_row_insert", "result": "ok"}],
            "bugs": [{"code": "RT_PAGE_DRIFT", "op": "roundtrip"}],
        }
        result, execution_failure, mutation_failure, coverage_skip = gate.classify_report(
            CASE, report, 1
        )
        self.assertIsNone(execution_failure)
        self.assertIsNone(coverage_skip)
        self.assertEqual(1, result["bugCount"])
        self.assertEqual(["RT_PAGE_DRIFT"], mutation_failure["bugCodes"])

    def test_parse_error_is_an_execution_failure(self) -> None:
        result, execution_failure, mutation_failure, coverage_skip = gate.classify_report(
            CASE, {"status": "parse_error:bad", "ops": [], "bugs": []}, 2
        )
        self.assertIsNone(result)
        self.assertIsNone(mutation_failure)
        self.assertIsNone(coverage_skip)
        self.assertIn("report status", execution_failure["reason"])

    def test_summary_keeps_execution_and_mutation_status_separate(self) -> None:
        result = {
            "caseId": "table-hwpx",
            "category": "table",
            "source": CASE["source"],
            "returnCode": 1,
            "operationCount": 3,
            "bugCount": 1,
            "bugCodes": ["RT_PAGE_DRIFT"],
            "elapsedMs": 12,
            "baseline": {"pages": 1},
            "domainCoverage": {
                "table": {"objectCount": 1, "operationCount": 3},
                "picture": {"objectCount": 0, "operationCount": 0},
                "text": {"operationCount": 0},
                "layered": {
                    "operationCount": 0,
                    "qualifyingOperationCountIncludingPictures": 0,
                },
            },
            "missingExpectedDomains": [],
        }
        summary = gate.build_summary(
            "a" * 64,
            selected_case_count=1,
            eligible_case_count=1,
            case_results=[result],
            execution_failures=[],
            mutation_failures=[{"caseId": "table-hwpx", "reason": "bug"}],
            skipped_cases=[],
        )
        self.assertEqual("complete", summary["executionStatus"])
        self.assertEqual("fail", summary["mutationSafetyStatus"])
        self.assertEqual(3, summary["counts"]["operations"])

    def test_zero_operation_report_is_skipped_and_incomplete(self) -> None:
        report = {
            "status": "ok",
            "elapsedMs": 1,
            "baseline": {"pages": 1, "tables": 1, "pictures": 0},
            "ops": [],
            "bugs": [],
        }
        result, execution_failure, mutation_failure, coverage_skip = (
            gate.classify_report(CASE, report, 0)
        )
        self.assertIsNone(execution_failure)
        self.assertIsNone(mutation_failure)
        self.assertEqual(0, result["operationCount"])
        self.assertIn("without executing", coverage_skip["reason"])
        summary = gate.build_summary(
            "a" * 64, 1, 1, [result], [], [], [coverage_skip]
        )
        self.assertEqual("incomplete", summary["executionStatus"])
        self.assertEqual("not-evaluated", summary["mutationSafetyStatus"])
        self.assertEqual(0, summary["counts"]["passedCases"])

    def test_layered_case_without_visual_object_ops_is_skipped(self) -> None:
        layered_case = {
            "id": "layered-table-only",
            "category": "layered",
            "source": "rhwp/samples/layered.hwpx",
        }
        report = {
            "status": "ok",
            "elapsedMs": 1,
            "baseline": {"pages": 1, "tables": 1, "pictures": 0},
            "ops": [{"name": "table_row_insert", "result": "ok"}],
            "bugs": [],
        }
        result, execution_failure, mutation_failure, coverage_skip = (
            gate.classify_report(layered_case, report, 0)
        )
        self.assertIsNone(execution_failure)
        self.assertIsNone(mutation_failure)
        self.assertEqual(0, result["domainCoverage"]["layered"]["operationCount"])
        self.assertEqual(["layered"], coverage_skip["missingExpectedDomains"])

    def test_reversible_floating_table_layer_op_qualifies_layered_case(self) -> None:
        layered_case = {
            "id": "layered-floating-tables",
            "category": "layered",
            "source": "rhwp/samples/layered.hwpx",
        }
        report = {
            "status": "ok",
            "elapsedMs": 1,
            "baseline": {
                "pages": 2,
                "tables": 2,
                "pictures": 0,
                "recursive": {
                    "tables": 2,
                    "pictures": 0,
                    "shapes": 0,
                    "groups": 0,
                    "floatingLayers": 2,
                },
            },
            "ops": [
                {"name": "table_props_noop", "result": "ok"},
                {"name": "layer_z_order_roundtrip", "result": "ok"},
            ],
            "bugs": [],
        }
        result, execution_failure, mutation_failure, coverage_skip = (
            gate.classify_report(layered_case, report, 0)
        )
        self.assertIsNone(execution_failure)
        self.assertIsNone(mutation_failure)
        self.assertIsNone(coverage_skip)
        self.assertEqual(1, result["domainCoverage"]["layered"]["operationCount"])
        self.assertEqual(2, result["domainCoverage"]["layered"]["floatingLayerCount"])

    def test_recursive_inventory_counts_and_nested_picture_ops_are_reported(self) -> None:
        picture_case = {
            "id": "picture-in-cell",
            "category": "picture",
            "source": "rhwp/samples/picture.hwpx",
        }
        report = {
            "status": "ok",
            "elapsedMs": 1,
            "baseline": {
                "pages": 1,
                "tables": 1,
                "pictures": 0,
                "recursive": {
                    "tables": 2,
                    "pictures": 3,
                    "shapes": 1,
                    "groups": 0,
                    "nestedTables": 1,
                    "nestedPictures": 3,
                    "floatingLayers": 1,
                },
            },
            "ops": [{"name": "pic_nested_set_noop", "result": "ok"}],
            "bugs": [],
        }
        result, execution_failure, mutation_failure, coverage_skip = (
            gate.classify_report(picture_case, report, 0)
        )
        self.assertIsNone(execution_failure)
        self.assertIsNone(mutation_failure)
        self.assertIsNone(coverage_skip)
        self.assertEqual(2, result["domainCoverage"]["table"]["objectCount"])
        self.assertEqual(1, result["domainCoverage"]["table"]["nestedObjectCount"])
        self.assertEqual(3, result["domainCoverage"]["picture"]["objectCount"])
        self.assertEqual(3, result["domainCoverage"]["picture"]["nestedObjectCount"])
        self.assertEqual(1, result["domainCoverage"]["picture"]["operationCount"])

    def test_unsupported_page_image_brush_remains_an_explicit_skip(self) -> None:
        picture_case = {
            "id": "picture-page-fill",
            "category": "picture",
            "source": "rhwp/samples/page-fill.hwpx",
        }
        report = {
            "status": "ok",
            "elapsedMs": 1,
            "baseline": {
                "pages": 1,
                "tables": 1,
                "pictures": 0,
                "recursive": {
                    "tables": 1,
                    "pictures": 0,
                    "shapes": 0,
                    "groups": 0,
                    "pageImageBrushes": 1,
                    "mutablePageImageBrushes": 0,
                },
            },
            "ops": [{"name": "table_props_noop", "result": "ok"}],
            "bugs": [],
        }
        result, execution_failure, mutation_failure, coverage_skip = (
            gate.classify_report(picture_case, report, 0)
        )
        self.assertIsNone(execution_failure)
        self.assertIsNone(mutation_failure)
        self.assertEqual(1, result["domainCoverage"]["picture"]["pageImageBrushCount"])
        self.assertEqual(
            0, result["domainCoverage"]["picture"]["mutablePageImageBrushCount"]
        )
        self.assertEqual(["picture"], coverage_skip["missingExpectedDomains"])
        self.assertIn("no supported lossless", coverage_skip["reason"])

    def test_lossless_page_image_brush_noop_qualifies_picture_case(self) -> None:
        picture_case = {
            "id": "picture-page-fill",
            "category": "picture",
            "source": "rhwp/samples/page-fill.hwpx",
        }
        report = {
            "status": "ok",
            "elapsedMs": 1,
            "baseline": {
                "pages": 1,
                "tables": 1,
                "pictures": 0,
                "recursive": {
                    "tables": 1,
                    "pictures": 0,
                    "shapes": 0,
                    "groups": 0,
                    "pageImageBrushes": 1,
                    "mutablePageImageBrushes": 1,
                },
            },
            "ops": [{"name": "pic_page_image_fill_noop", "result": "ok"}],
            "bugs": [],
        }

        result, execution_failure, mutation_failure, coverage_skip = (
            gate.classify_report(picture_case, report, 0)
        )
        self.assertIsNone(execution_failure)
        self.assertIsNone(mutation_failure)
        self.assertIsNone(coverage_skip)
        self.assertEqual(1, result["domainCoverage"]["picture"]["operationCount"])
        self.assertEqual(
            1, result["domainCoverage"]["picture"]["mutablePageImageBrushCount"]
        )

    def test_writes_summary_with_non_parity_disclaimer(self) -> None:
        summary = gate.build_summary(
            "a" * 64,
            0,
            0,
            [],
            [],
            [],
            [],
            rhwp_binary_path="/tmp/rhwp",
            rhwp_binary_sha256="b" * 64,
        )
        with tempfile.TemporaryDirectory() as temporary:
            json_path, markdown_path = gate.write_summary(Path(temporary), summary)
            decoded = json.loads(json_path.read_text(encoding="utf-8"))
            markdown = markdown_path.read_text(encoding="utf-8")
        self.assertIn("not post-edit Hancom parity", decoded["disclaimer"])
        self.assertIn("not post-edit Hancom parity", markdown)
        self.assertEqual("/tmp/rhwp", decoded["rhwpBinary"]["path"])
        self.assertEqual("b" * 64, decoded["rhwpBinary"]["sha256"])
        self.assertIn("b" * 64, markdown)


if __name__ == "__main__":
    unittest.main()
