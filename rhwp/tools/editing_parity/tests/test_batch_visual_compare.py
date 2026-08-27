from __future__ import annotations

from argparse import ArgumentTypeError
from contextlib import redirect_stdout
import io
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest import mock


TOOL_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(TOOL_ROOT))

import batch_visual_compare as batch  # noqa: E402


class BatchVisualCompareTests(unittest.TestCase):
    def test_percentage_rejects_out_of_range_values(self) -> None:
        self.assertEqual(50.5, batch.percentage("50.5"))
        with self.assertRaises(ArgumentTypeError):
            batch.percentage("101")

    def test_case_metrics_and_missing_pages(self) -> None:
        case = {
            "id": "table-example",
            "category": "table",
            "oracleProvenance": "hancom",
        }
        rows = [
            {
                "page": 1,
                "pixel_match_percent": 90.0,
                "ink_match_percent": 80.0,
                "visual_accuracy_proxy_percent": 80.0,
            },
            {
                "page": 2,
                "pixel_match_percent": 100.0,
                "ink_match_percent": 90.0,
                "visual_accuracy_proxy_percent": 90.0,
            },
        ]
        with tempfile.TemporaryDirectory() as temporary:
            metrics = Path(temporary) / "metrics.json"
            metrics.write_text(json.dumps(rows), encoding="utf-8")
            summary, failure, skipped = batch.summarize_case_metrics(
                case, {1, 2, 3}, metrics
            )
        self.assertIsNone(failure)
        self.assertEqual(95.0, summary["averagePixelMatchPercent"])
        self.assertEqual(85.0, summary["averageInkMatchPercent"])
        self.assertEqual(90.0, summary["minimumPixelMatchPercent"])
        self.assertEqual([1], summary["minimumPixelMatchPages"])
        self.assertEqual(80.0, summary["minimumInkMatchPercent"])
        self.assertEqual([1], summary["minimumInkMatchPages"])
        self.assertEqual([3], skipped["missingPages"])

    def test_aggregate_is_case_weighted_and_orders_worst(self) -> None:
        summaries = [
            {
                "caseId": "a",
                "category": "table",
                "provenance": "hancom",
                "requestedPageCount": 2,
                "comparedPageCount": 2,
                "averagePixelMatchPercent": 95.0,
                "averageInkMatchPercent": 90.0,
                "averageVisualAccuracyProxyPercent": 90.0,
            },
            {
                "caseId": "b",
                "category": "table",
                "provenance": "diagnostic",
                "requestedPageCount": 1,
                "comparedPageCount": 1,
                "averagePixelMatchPercent": 70.0,
                "averageInkMatchPercent": 60.0,
                "averageVisualAccuracyProxyPercent": 60.0,
            },
            {
                "caseId": "c",
                "category": "picture",
                "provenance": "hancom",
                "requestedPageCount": 1,
                "comparedPageCount": 1,
                "averagePixelMatchPercent": 99.0,
                "averageInkMatchPercent": 98.0,
                "averageVisualAccuracyProxyPercent": 98.0,
            },
        ]
        aggregate = batch.build_aggregate(
            "a" * 64, 5, 5, summaries, [{"caseId": "d", "reason": "failed"}],
            [{"caseId": "e", "reason": "skipped"}], 96.0
        )
        table = aggregate["averages"]["byCategory"]["table"]
        hancom = aggregate["averages"]["byProvenance"]["hancom"]
        self.assertEqual(82.5, table["averagePixelMatchPercent"])
        self.assertEqual(75.0, table["averageInkMatchPercent"])
        self.assertEqual(97.0, hancom["averagePixelMatchPercent"])
        self.assertEqual(["b", "a", "c"], [row["caseId"] for row in aggregate["worst10Cases"]])
        self.assertEqual("incomplete", aggregate["executionStatus"])

    def test_writes_machine_and_markdown_summaries(self) -> None:
        aggregate = batch.build_aggregate(
            "a" * 64, 0, 0, [], [], [], 96.0
        )
        with tempfile.TemporaryDirectory() as temporary:
            json_path, markdown_path = batch.write_aggregate(
                Path(temporary), aggregate
            )
            decoded = json.loads(json_path.read_text(encoding="utf-8"))
            markdown = markdown_path.read_text(encoding="utf-8")
        self.assertEqual("complete", decoded["executionStatus"])
        self.assertEqual("not-evaluated", decoded["fidelityThresholdStatus"])
        self.assertIn("## Category averages", markdown)
        self.assertIn("## Failed cases", markdown)
        self.assertIn("## Skipped cases", markdown)

    def test_explicit_thresholds_fail_independently(self) -> None:
        summary = {
            "caseId": "low-fidelity",
            "category": "picture",
            "provenance": "hancom",
            "requestedPageCount": 1,
            "comparedPageCount": 1,
            "averagePixelMatchPercent": 91.0,
            "averageInkMatchPercent": 30.0,
            "averageVisualAccuracyProxyPercent": 30.0,
        }
        aggregate = batch.build_aggregate(
            "a" * 64,
            1,
            1,
            [summary],
            [],
            [],
            96.0,
            minimum_pixel_match=90.0,
            minimum_ink_match=50.0,
        )
        self.assertEqual("complete", aggregate["executionStatus"])
        self.assertEqual("fail", aggregate["fidelityThresholdStatus"])
        self.assertEqual(["ink"], aggregate["thresholdFailures"][0]["failedThresholds"])

    def test_summarize_only_cli_applies_page_threshold_flag(self) -> None:
        rows = [
            {
                "page": 1,
                "pixel_match_percent": 95.0,
                "ink_match_percent": 25.0,
                "visual_accuracy_proxy_percent": 25.0,
            }
        ]
        with tempfile.TemporaryDirectory() as temporary:
            out_root = Path(temporary)
            case_root = out_root / "picture-crop"
            case_root.mkdir()
            (case_root / "metrics.json").write_text(
                json.dumps(rows), encoding="utf-8"
            )
            with redirect_stdout(io.StringIO()):
                return_code = batch.main(
                    [
                        "--case",
                        "picture-crop",
                        "--pages",
                        "1",
                        "--summarize-only",
                        "--min-page-ink-match",
                        "50",
                        "--out",
                        str(out_root),
                    ]
                )
            summary = json.loads((out_root / "summary.json").read_text())
        self.assertEqual(1, return_code)
        self.assertEqual("complete", summary["executionStatus"])
        self.assertEqual("fail", summary["fidelityThresholdStatus"])
        self.assertEqual({"ink": [1]}, summary["thresholdFailures"][0]["offendingPages"])

    def test_metrics_only_flag_is_forwarded_to_native_comparator(self) -> None:
        output = io.StringIO()
        with redirect_stdout(output):
            return_code = batch.main(
                [
                    "--case",
                    "picture-crop",
                    "--pages",
                    "1",
                    "--metrics-only",
                    "--dry-run",
                ]
            )
        self.assertEqual(0, return_code)
        self.assertIn("--metrics-only", output.getvalue())

    def test_nonzero_comparator_retains_partial_page_metrics(self) -> None:
        rows = [
            {
                "page": 1,
                "pixel_match_percent": 91.0,
                "ink_match_percent": 31.0,
                "visual_accuracy_proxy_percent": 31.0,
            }
        ]
        with tempfile.TemporaryDirectory() as temporary:
            out_root = Path(temporary)
            case_root = out_root / "picture-in-table"
            case_root.mkdir()
            (case_root / "metrics.json").write_text(
                json.dumps(rows), encoding="utf-8"
            )
            completed = mock.Mock(returncode=1)
            with mock.patch.object(batch.subprocess, "run", return_value=completed):
                with redirect_stdout(io.StringIO()):
                    return_code = batch.main(
                        [
                            "--case",
                            "picture-in-table",
                            "--pages",
                            "1-2",
                            "--out",
                            str(out_root),
                        ]
                    )
            summary = json.loads((out_root / "summary.json").read_text())

        self.assertEqual(1, return_code)
        self.assertEqual(1, summary["counts"]["completedCases"])
        self.assertEqual(1, summary["counts"]["comparedPages"])
        self.assertEqual(1, summary["counts"]["failedCases"])
        self.assertEqual(1, summary["counts"]["skippedCases"])
        self.assertEqual([2], summary["skippedCases"][0]["missingPages"])

    def test_page_threshold_cannot_be_hidden_by_case_mean(self) -> None:
        summary = {
            "caseId": "one-bad-page",
            "category": "picture",
            "provenance": "hancom",
            "requestedPageCount": 2,
            "comparedPageCount": 2,
            "averagePixelMatchPercent": 95.0,
            "averageInkMatchPercent": 90.0,
            "averageVisualAccuracyProxyPercent": 90.0,
            "minimumPixelMatchPercent": 89.0,
            "minimumPixelMatchPages": [2],
            "minimumInkMatchPercent": 79.0,
            "minimumInkMatchPages": [2],
            "pageMetrics": [
                {"page": 1, "pixelMatchPercent": 100.0, "inkMatchPercent": 100.0},
                {"page": 2, "pixelMatchPercent": 89.0, "inkMatchPercent": 79.0},
            ],
        }
        aggregate = batch.build_aggregate(
            "a" * 64,
            1,
            2,
            [summary],
            [],
            [],
            96.0,
            minimum_page_pixel_match=90.0,
            minimum_page_ink_match=80.0,
        )
        failure = aggregate["thresholdFailures"][0]
        self.assertEqual("fail", aggregate["fidelityThresholdStatus"])
        self.assertEqual(["pagePixel", "pageInk"], failure["failedThresholds"])
        self.assertEqual({"pixel": [2], "ink": [2]}, failure["offendingPages"])
        self.assertEqual(
            89.0, aggregate["caseSummaries"][0]["minimumPixelMatchPercent"]
        )
        self.assertNotIn("pageMetrics", aggregate["caseSummaries"][0])


if __name__ == "__main__":
    unittest.main()
