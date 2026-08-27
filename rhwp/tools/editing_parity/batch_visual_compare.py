#!/usr/bin/env python3
"""Run the existing native visual oracle for selected editing-parity cases."""

from __future__ import annotations

import argparse
import importlib.util
import json
from pathlib import Path
import shlex
from statistics import fmean
import subprocess
import sys
from typing import Any

import validate


OPTIONAL_MODULES = {
    "fitz": "PyMuPDF",
    "PIL": "Pillow",
    "numpy": "numpy",
}


def percentage(value: str) -> float:
    try:
        parsed = float(value)
    except ValueError as error:
        raise argparse.ArgumentTypeError("expected a percentage from 0 to 100") from error
    if not 0.0 <= parsed <= 100.0:
        raise argparse.ArgumentTypeError("expected a percentage from 0 to 100")
    return parsed


def parse_case_pages(value: str) -> tuple[str, str]:
    case_id, separator, pages = value.partition("=")
    if not separator or not case_id or not pages:
        raise argparse.ArgumentTypeError("expected CASE_ID=PAGES")
    return case_id, pages


def page_numbers(spec: str, maximum: int) -> set[int]:
    if spec == "all":
        return set(range(1, maximum + 1))
    selected: set[int] = set()
    try:
        for part in spec.split(","):
            if "-" in part:
                start_text, end_text = part.split("-", 1)
                start, end = int(start_text), int(end_text)
                if start > end:
                    raise ValueError
                selected.update(range(start, end + 1))
            else:
                selected.add(int(part))
    except ValueError as error:
        raise SystemExit(f"invalid page specification {spec!r}") from error
    if not selected or min(selected) < 1 or max(selected) > maximum:
        raise SystemExit(f"pages {spec!r} fall outside 1..{maximum}")
    return selected


def resolve_pages(spec: str, maximum: int) -> str:
    selected = page_numbers(spec, maximum)
    if spec == "all":
        return f"1-{maximum}"
    return spec


def _metric_number(row: dict[str, Any], key: str) -> float:
    value = row.get(key)
    if not isinstance(value, (int, float)) or isinstance(value, bool):
        raise ValueError(f"metric {key} must be numeric")
    return float(value)


def summarize_case_metrics(
    case: dict[str, Any], requested_pages: set[int], metrics_path: Path
) -> tuple[dict[str, Any] | None, dict[str, Any] | None, dict[str, Any] | None]:
    case_id = case["id"]
    try:
        rows = json.loads(metrics_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        return None, {
            "caseId": case_id,
            "reason": f"cannot read metrics.json: {error}",
        }, None
    if not isinstance(rows, list):
        return None, {"caseId": case_id, "reason": "metrics.json must be an array"}, None
    if not rows:
        return None, None, {
            "caseId": case_id,
            "reason": "no pages were compared",
            "requestedPages": sorted(requested_pages),
            "comparedPages": [],
        }

    try:
        if any(not isinstance(row, dict) for row in rows):
            raise ValueError("metric rows must be objects")
        compared_pages = [row.get("page") for row in rows]
        if any(not isinstance(page, int) or isinstance(page, bool) for page in compared_pages):
            raise ValueError("metric page must be an integer")
        if len(compared_pages) != len(set(compared_pages)):
            raise ValueError("metric pages must be unique")
        pixel_values = [_metric_number(row, "pixel_match_percent") for row in rows]
        ink_values = [_metric_number(row, "ink_match_percent") for row in rows]
        proxy_values = [
            _metric_number(row, "visual_accuracy_proxy_percent") for row in rows
        ]
    except ValueError as error:
        return None, {"caseId": case_id, "reason": str(error)}, None

    compared_set = set(compared_pages)
    unexpected = sorted(compared_set - requested_pages)
    if unexpected:
        return None, {
            "caseId": case_id,
            "reason": f"metrics contain unexpected pages: {unexpected}",
        }, None

    summary = {
        "caseId": case_id,
        "category": case["category"],
        "provenance": case["oracleProvenance"],
        "requestedPageCount": len(requested_pages),
        "comparedPageCount": len(rows),
        "averagePixelMatchPercent": round(fmean(pixel_values), 4),
        "averageInkMatchPercent": round(fmean(ink_values), 4),
        "averageVisualAccuracyProxyPercent": round(fmean(proxy_values), 4),
        "minimumPixelMatchPercent": round(min(pixel_values), 4),
        "minimumPixelMatchPages": sorted(
            row["page"]
            for row, value in zip(rows, pixel_values)
            if value == min(pixel_values)
        ),
        "minimumInkMatchPercent": round(min(ink_values), 4),
        "minimumInkMatchPages": sorted(
            row["page"]
            for row, value in zip(rows, ink_values)
            if value == min(ink_values)
        ),
        "pageMetrics": [
            {
                "page": row["page"],
                "pixelMatchPercent": pixel,
                "inkMatchPercent": ink,
            }
            for row, pixel, ink in zip(rows, pixel_values, ink_values)
        ],
    }
    missing = sorted(requested_pages - compared_set)
    skipped = None
    if missing:
        skipped = {
            "caseId": case_id,
            "reason": "requested pages were not compared",
            "requestedPages": sorted(requested_pages),
            "comparedPages": sorted(compared_set),
            "missingPages": missing,
        }
    return summary, None, skipped


def _group_averages(
    case_summaries: list[dict[str, Any]], field: str
) -> dict[str, dict[str, Any]]:
    output: dict[str, dict[str, Any]] = {}
    keys = dict.fromkeys(summary[field] for summary in case_summaries)
    for key in keys:
        rows = [summary for summary in case_summaries if summary[field] == key]
        output[key] = {
            "caseCount": len(rows),
            "pageCount": sum(row["comparedPageCount"] for row in rows),
            "averagePixelMatchPercent": round(
                fmean(row["averagePixelMatchPercent"] for row in rows), 4
            ),
            "averageInkMatchPercent": round(
                fmean(row["averageInkMatchPercent"] for row in rows), 4
            ),
        }
    return output


def build_aggregate(
    corpus_sha256: str,
    selected_case_count: int,
    requested_page_count: int,
    case_summaries: list[dict[str, Any]],
    failed_cases: list[dict[str, Any]],
    skipped_cases: list[dict[str, Any]],
    dpi: float,
    minimum_pixel_match: float | None = None,
    minimum_ink_match: float | None = None,
    minimum_page_pixel_match: float | None = None,
    minimum_page_ink_match: float | None = None,
) -> dict[str, Any]:
    worst_rows = sorted(
        case_summaries,
        key=lambda row: (
            row["averageInkMatchPercent"],
            row["averagePixelMatchPercent"],
            row["caseId"],
        ),
    )[:10]
    public_summaries = [
        {key: value for key, value in row.items() if key != "pageMetrics"}
        for row in case_summaries
    ]
    worst = [
        {key: value for key, value in row.items() if key != "pageMetrics"}
        for row in worst_rows
    ]
    threshold_failures = []
    for summary in case_summaries:
        failed_thresholds = []
        offending_pages: dict[str, list[int]] = {}
        if (
            minimum_pixel_match is not None
            and summary["averagePixelMatchPercent"] < minimum_pixel_match
        ):
            failed_thresholds.append("pixel")
        if (
            minimum_ink_match is not None
            and summary["averageInkMatchPercent"] < minimum_ink_match
        ):
            failed_thresholds.append("ink")
        page_metrics = summary.get("pageMetrics", [])
        if minimum_page_pixel_match is not None:
            pages = sorted(
                row["page"]
                for row in page_metrics
                if row["pixelMatchPercent"] < minimum_page_pixel_match
            )
            if pages:
                failed_thresholds.append("pagePixel")
                offending_pages["pixel"] = pages
        if minimum_page_ink_match is not None:
            pages = sorted(
                row["page"]
                for row in page_metrics
                if row["inkMatchPercent"] < minimum_page_ink_match
            )
            if pages:
                failed_thresholds.append("pageInk")
                offending_pages["ink"] = pages
        if failed_thresholds:
            threshold_failures.append(
                {
                    "caseId": summary["caseId"],
                    "averagePixelMatchPercent": summary[
                        "averagePixelMatchPercent"
                    ],
                    "averageInkMatchPercent": summary["averageInkMatchPercent"],
                    "failedThresholds": failed_thresholds,
                    "offendingPages": offending_pages,
                }
            )
    thresholds_enabled = (
        minimum_pixel_match is not None
        or minimum_ink_match is not None
        or minimum_page_pixel_match is not None
        or minimum_page_ink_match is not None
    )
    return {
        "schemaVersion": 1,
        "corpusSha256": corpus_sha256,
        "executionStatus": (
            "complete" if not failed_cases and not skipped_cases else "incomplete"
        ),
        "fidelityThresholdStatus": (
            "not-evaluated"
            if not thresholds_enabled
            else "fail" if threshold_failures else "pass"
        ),
        "aggregation": "case-weighted mean of each case's page means",
        "dpi": dpi,
        "thresholds": {
            "minimumPixelMatchPercent": minimum_pixel_match,
            "minimumInkMatchPercent": minimum_ink_match,
            "minimumPagePixelMatchPercent": minimum_page_pixel_match,
            "minimumPageInkMatchPercent": minimum_page_ink_match,
        },
        "counts": {
            "selectedCases": selected_case_count,
            "completedCases": len(case_summaries),
            "requestedPages": requested_page_count,
            "comparedPages": sum(
                summary["comparedPageCount"] for summary in case_summaries
            ),
            "failedCases": len(failed_cases),
            "skippedCases": len(skipped_cases),
            "thresholdFailedCases": len(threshold_failures),
        },
        "averages": {
            "byCategory": _group_averages(case_summaries, "category"),
            "byProvenance": _group_averages(case_summaries, "provenance"),
        },
        "caseSummaries": public_summaries,
        "worst10Cases": worst,
        "failedCases": failed_cases,
        "skippedCases": skipped_cases,
        "thresholdFailures": threshold_failures,
    }


def _markdown_table(title: str, first_column: str, rows: dict[str, Any]) -> list[str]:
    output = [
        f"## {title}",
        "",
        f"| {first_column} | Cases | Pages | Pixel match | Ink match |",
        "| --- | ---: | ---: | ---: | ---: |",
    ]
    for name, metrics in rows.items():
        output.append(
            f"| {name} | {metrics['caseCount']} | {metrics['pageCount']} | "
            f"{metrics['averagePixelMatchPercent']:.4f}% | "
            f"{metrics['averageInkMatchPercent']:.4f}% |"
        )
    output.append("")
    return output


def aggregate_markdown(aggregate: dict[str, Any]) -> str:
    counts = aggregate["counts"]
    thresholds = aggregate["thresholds"]
    minimum_pixel = thresholds["minimumPixelMatchPercent"]
    minimum_ink = thresholds["minimumInkMatchPercent"]
    minimum_page_pixel = thresholds["minimumPagePixelMatchPercent"]
    minimum_page_ink = thresholds["minimumPageInkMatchPercent"]
    lines = [
        "# Editing parity aggregate",
        "",
        f"Execution status: **{aggregate['executionStatus'].upper()}**",
        f"Fidelity threshold status: **{aggregate['fidelityThresholdStatus'].upper()}**",
        "",
        f"- Selected cases: {counts['selectedCases']}",
        f"- Completed cases: {counts['completedCases']}",
        f"- Compared pages: {counts['comparedPages']} / {counts['requestedPages']}",
        f"- Failed cases: {counts['failedCases']}",
        f"- Skipped cases: {counts['skippedCases']}",
        f"- Threshold-failed cases: {counts['thresholdFailedCases']}",
        f"- Minimum pixel match: {minimum_pixel if minimum_pixel is not None else 'not set'}",
        f"- Minimum ink match: {minimum_ink if minimum_ink is not None else 'not set'}",
        f"- Minimum page pixel match: {minimum_page_pixel if minimum_page_pixel is not None else 'not set'}",
        f"- Minimum page ink match: {minimum_page_ink if minimum_page_ink is not None else 'not set'}",
        f"- Aggregation: {aggregate['aggregation']}",
        "",
    ]
    lines.extend(
        _markdown_table(
            "Category averages", "Category", aggregate["averages"]["byCategory"]
        )
    )
    lines.extend(
        [
            "## Case minima",
            "",
            "| Case | Minimum pixel | Page(s) | Minimum ink | Page(s) |",
            "| --- | ---: | --- | ---: | --- |",
        ]
    )
    for row in aggregate["caseSummaries"]:
        lines.append(
            f"| {row['caseId']} | {row['minimumPixelMatchPercent']:.4f}% | "
            f"{', '.join(map(str, row['minimumPixelMatchPages']))} | "
            f"{row['minimumInkMatchPercent']:.4f}% | "
            f"{', '.join(map(str, row['minimumInkMatchPages']))} |"
        )
    lines.append("")
    lines.extend(
        _markdown_table(
            "Provenance averages",
            "Provenance",
            aggregate["averages"]["byProvenance"],
        )
    )
    lines.extend(
        [
            "## Worst 10 cases",
            "",
            "| Case | Category | Provenance | Pages | Pixel match | Ink match |",
            "| --- | --- | --- | ---: | ---: | ---: |",
        ]
    )
    for row in aggregate["worst10Cases"]:
        lines.append(
            f"| {row['caseId']} | {row['category']} | {row['provenance']} | "
            f"{row['comparedPageCount']} | {row['averagePixelMatchPercent']:.4f}% | "
            f"{row['averageInkMatchPercent']:.4f}% |"
        )
    lines.extend(["", "## Failed cases", ""])
    failed = aggregate["failedCases"]
    lines.extend(
        [f"- `{row['caseId']}`: {row['reason']}" for row in failed]
        if failed
        else ["None"]
    )
    lines.extend(["", "## Skipped cases", ""])
    skipped = aggregate["skippedCases"]
    lines.extend(
        [f"- `{row['caseId']}`: {row['reason']}" for row in skipped]
        if skipped
        else ["None"]
    )
    lines.extend(["", "## Fidelity threshold failures", ""])
    threshold_failures = aggregate["thresholdFailures"]
    lines.extend(
        [
            f"- `{row['caseId']}`: {', '.join(row['failedThresholds'])}; "
            f"pixel {row['averagePixelMatchPercent']:.4f}%, "
            f"ink {row['averageInkMatchPercent']:.4f}%; "
            f"offending pages {row['offendingPages'] or 'none'}"
            for row in threshold_failures
        ]
        if threshold_failures
        else ["None"]
    )
    return "\n".join(lines) + "\n"


def write_aggregate(out_root: Path, aggregate: dict[str, Any]) -> tuple[Path, Path]:
    out_root.mkdir(parents=True, exist_ok=True)
    json_path = out_root / "summary.json"
    markdown_path = out_root / "summary.md"
    json_path.write_text(
        json.dumps(aggregate, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    markdown_path.write_text(aggregate_markdown(aggregate), encoding="utf-8")
    return json_path, markdown_path


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    selection = parser.add_mutually_exclusive_group(required=True)
    selection.add_argument("--case", action="append", dest="case_ids")
    selection.add_argument("--all", action="store_true", help="run all 50 cases")
    parser.add_argument(
        "--pages", default="1", help="default 1-based pages, ranges, or 'all'"
    )
    parser.add_argument(
        "--case-pages",
        action="append",
        default=[],
        type=parse_case_pages,
        metavar="CASE_ID=PAGES",
        help="override pages for one selected case",
    )
    parser.add_argument("--dpi", type=float, default=96.0)
    parser.add_argument(
        "--min-pixel-match",
        type=percentage,
        help="fail when a case's mean pixel match is below this percentage",
    )
    parser.add_argument(
        "--min-ink-match",
        type=percentage,
        help="fail when a case's mean ink match is below this percentage",
    )
    parser.add_argument(
        "--min-page-pixel-match",
        type=percentage,
        help="fail when any page's pixel match is below this percentage",
    )
    parser.add_argument(
        "--min-page-ink-match",
        type=percentage,
        help="fail when any page's ink match is below this percentage",
    )
    parser.add_argument(
        "--out",
        type=Path,
        default=validate.DEFAULT_REPO_ROOT / "rhwp" / "output" / "editing-parity",
    )
    parser.add_argument("--font-path", action="append", default=[])
    parser.add_argument(
        "--metrics-only",
        action="store_true",
        help="compute metrics without retaining per-page PNG/review artifacts",
    )
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument(
        "--summarize-only",
        action="store_true",
        help="aggregate existing per-case metrics without invoking the comparator",
    )
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    if args.dry_run and args.summarize_only:
        print("--dry-run and --summarize-only cannot be combined", file=sys.stderr)
        return 2
    result = validate.validate_manifest()
    if not result.ok:
        print("corpus validation failed; run validate.py for details", file=sys.stderr)
        return 1

    data = validate.load_manifest(validate.DEFAULT_MANIFEST)
    cases = data["cases"]
    by_id = {case["id"]: case for case in cases}
    selected_ids = list(by_id) if args.all else list(dict.fromkeys(args.case_ids or []))
    unknown = [case_id for case_id in selected_ids if case_id not in by_id]
    if unknown:
        print(f"unknown case id(s): {', '.join(unknown)}", file=sys.stderr)
        return 2

    page_overrides = dict(args.case_pages)
    unselected_overrides = sorted(set(page_overrides) - set(selected_ids))
    if unselected_overrides:
        print(
            f"page override for unselected case(s): {', '.join(unselected_overrides)}",
            file=sys.stderr,
        )
        return 2


    missing_modules = [
        package
        for module, package in OPTIONAL_MODULES.items()
        if importlib.util.find_spec(module) is None
    ]
    if missing_modules and not args.dry_run and not args.summarize_only:
        print(
            "native visual comparison requires: " + " ".join(missing_modules),
            file=sys.stderr,
        )
        print("install with: python3 -m pip install PyMuPDF Pillow numpy", file=sys.stderr)
        return 2

    repo_root = validate.DEFAULT_REPO_ROOT
    rhwp_root = repo_root / "rhwp"
    oracle_script = rhwp_root / "scripts" / "visual_oracle_native.py"
    out_root = args.out.resolve()
    plan = []
    for case_id in selected_ids:
        case = by_id[case_id]
        pages = resolve_pages(page_overrides.get(case_id, args.pages), case["pageCount"])
        plan.append((case, pages, page_numbers(pages, case["pageCount"])))

    case_summaries: list[dict[str, Any]] = []
    failed_cases: list[dict[str, Any]] = []
    skipped_cases: list[dict[str, Any]] = []
    for case, pages, requested_pages in plan:
        case_id = case["id"]
        command = [
            sys.executable,
            str(oracle_script),
            "--hwp",
            str(repo_root / case["source"]),
            "--pdf",
            str(repo_root / case["oraclePdf"]),
            "--pages",
            pages,
            "--dpi",
            str(args.dpi),
            "--out",
            str(out_root / case_id),
        ]
        for font_path in args.font_path:
            command.extend(["--font-path", font_path])
        if args.metrics_only:
            command.append("--metrics-only")
        if args.dry_run:
            print(shlex.join(command))
            continue
        if not args.summarize_only:
            print(shlex.join(command))
            completed = subprocess.run(command, cwd=rhwp_root, check=False)
            if completed.returncode != 0:
                failed_cases.append(
                    {
                        "caseId": case_id,
                        "reason": "native visual comparator exited nonzero",
                        "returnCode": completed.returncode,
                    }
                )
        summary, failure, skipped = summarize_case_metrics(
            case, requested_pages, out_root / case_id / "metrics.json"
        )
        if summary is not None:
            case_summaries.append(summary)
        if failure is not None:
            failed_cases.append(failure)
        if skipped is not None:
            skipped_cases.append(skipped)

    if args.dry_run:
        return 0
    aggregate = build_aggregate(
        corpus_sha256=data["corpusSha256"],
        selected_case_count=len(plan),
        requested_page_count=sum(len(requested) for _, _, requested in plan),
        case_summaries=case_summaries,
        failed_cases=failed_cases,
        skipped_cases=skipped_cases,
        dpi=args.dpi,
        minimum_pixel_match=args.min_pixel_match,
        minimum_ink_match=args.min_ink_match,
        minimum_page_pixel_match=args.min_page_pixel_match,
        minimum_page_ink_match=args.min_page_ink_match,
    )
    json_path, markdown_path = write_aggregate(out_root, aggregate)
    print(f"aggregate JSON: {json_path}")
    print(f"aggregate Markdown: {markdown_path}")
    return 0 if (
        aggregate["executionStatus"] == "complete"
        and aggregate["fidelityThresholdStatus"] != "fail"
    ) else 1


if __name__ == "__main__":
    sys.exit(main())
