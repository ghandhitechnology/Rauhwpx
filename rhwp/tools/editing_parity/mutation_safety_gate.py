#!/usr/bin/env python3
"""Batch the real rhwp edit-stress diagnostic over editing-parity cases."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
import shlex
import subprocess
import sys
from typing import Any

import validate


DISCLAIMER = (
    "Mutation safety checks local edit, render, serialization, and restore invariants. "
    "It does not compare post-edit output with Hancom and is not post-edit Hancom parity."
)


def find_rhwp_binary(explicit: Path | None) -> Path | None:
    if explicit is not None:
        candidate = explicit.expanduser().resolve()
        return candidate if candidate.is_file() else None
    rhwp_root = validate.DEFAULT_REPO_ROOT / "rhwp"
    for relative in (
        "target/release/rhwp",
        "target/release/rhwp.exe",
        "target/debug/rhwp",
        "target/debug/rhwp.exe",
    ):
        candidate = rhwp_root / relative
        if candidate.is_file():
            return candidate.resolve()
    return None


def classify_report(
    case: dict[str, Any], report: Any, return_code: int | None
) -> tuple[
    dict[str, Any] | None,
    dict[str, Any] | None,
    dict[str, Any] | None,
    dict[str, Any] | None,
]:
    case_id = case["id"]
    if not isinstance(report, dict):
        return None, {"caseId": case_id, "reason": "report must be an object"}, None, None
    status = report.get("status")
    ops = report.get("ops")
    bugs = report.get("bugs")
    if status != "ok":
        return None, {
            "caseId": case_id,
            "reason": f"edit-stress report status is {status!r}",
            "returnCode": return_code,
        }, None, None
    if not isinstance(ops, list) or not isinstance(bugs, list):
        return None, {
            "caseId": case_id,
            "reason": "edit-stress report requires ops and bugs arrays",
            "returnCode": return_code,
        }, None, None
    if return_code not in {0, 1, None}:
        return None, {
            "caseId": case_id,
            "reason": "edit-stress command exited without a diagnostic result",
            "returnCode": return_code,
        }, None, None

    operation_names = [
        op.get("name", "")
        for op in ops
        if isinstance(op, dict) and isinstance(op.get("name", ""), str)
    ]
    table_operation_count = sum(
        name.startswith(("table_", "cell_")) for name in operation_names
    )
    picture_operation_count = sum(name.startswith("pic_") for name in operation_names)
    shape_operation_count = sum(name.startswith("shape_") for name in operation_names)
    layer_operation_count = sum(name.startswith("layer_") for name in operation_names)
    visual_operation_count = (
        picture_operation_count + shape_operation_count + layer_operation_count
    )
    text_operation_count = (
        len(operation_names) - table_operation_count - visual_operation_count
    )
    baseline = report.get("baseline") if isinstance(report.get("baseline"), dict) else {}
    recursive_baseline = (
        baseline.get("recursive")
        if isinstance(baseline.get("recursive"), dict)
        else {}
    )
    expected_domains = []
    if case["category"] == "table":
        expected_domains.append("table")
    elif case["category"] == "picture":
        expected_domains.append("picture")
    elif case["category"] == "layered":
        expected_domains.append("layered")
    elif case["category"] == "mixed":
        expected_domains.extend(("table", "layered"))
    domain_operations = {
        "table": table_operation_count,
        "picture": picture_operation_count,
        "layered": visual_operation_count,
    }
    missing_expected_domains = [
        domain for domain in expected_domains if domain_operations[domain] == 0
    ]
    domain_coverage = {
        "table": {
            "objectCount": recursive_baseline.get("tables", baseline.get("tables")),
            "topLevelObjectCount": baseline.get("tables"),
            "nestedObjectCount": recursive_baseline.get("nestedTables"),
            "operationCount": table_operation_count,
        },
        "picture": {
            "objectCount": recursive_baseline.get(
                "pictures", baseline.get("pictures")
            ),
            "topLevelObjectCount": baseline.get("pictures"),
            "nestedObjectCount": recursive_baseline.get("nestedPictures"),
            "pageImageBrushCount": recursive_baseline.get("pageImageBrushes"),
            "mutablePageImageBrushCount": recursive_baseline.get(
                "mutablePageImageBrushes"
            ),
            "operationCount": picture_operation_count,
        },
        "text": {"operationCount": text_operation_count},
        "layered": {
            "shapeObjectCount": recursive_baseline.get("shapes"),
            "groupObjectCount": recursive_baseline.get("groups"),
            "floatingLayerCount": recursive_baseline.get("floatingLayers"),
            "operationCount": shape_operation_count + layer_operation_count,
            "qualifyingOperationCountIncludingPictures": visual_operation_count,
        },
    }

    bug_codes = sorted(
        {
            bug.get("code", "UNKNOWN")
            for bug in bugs
            if isinstance(bug, dict) and isinstance(bug.get("code", "UNKNOWN"), str)
        }
    )
    result = {
        "caseId": case_id,
        "category": case["category"],
        "source": case["source"],
        "returnCode": return_code,
        "operationCount": len(ops),
        "bugCount": len(bugs),
        "bugCodes": bug_codes,
        "elapsedMs": report.get("elapsedMs"),
        "baseline": report.get("baseline"),
        "domainCoverage": domain_coverage,
        "missingExpectedDomains": missing_expected_domains,
    }
    has_mutation_failure = bool(bugs) or return_code == 1
    mutation_failure = None
    if has_mutation_failure:
        mutation_failure = {
            "caseId": case_id,
            "reason": "edit-stress found mutation-safety defects",
            "returnCode": return_code,
            "bugCount": len(bugs),
            "bugCodes": bug_codes,
        }
    coverage_skip = None
    if not ops:
        coverage_skip = {
            "caseId": case_id,
            "reason": "edit-stress completed without executing mutation operations",
            "missingExpectedDomains": expected_domains,
        }
    elif missing_expected_domains:
        reason = (
            "edit-stress executed no operations for the expected domain(s): "
            + ", ".join(missing_expected_domains)
        )
        page_image_brush_count = recursive_baseline.get("pageImageBrushes", 0)
        if (
            missing_expected_domains == ["picture"]
            and isinstance(page_image_brush_count, int)
            and page_image_brush_count > 0
            and picture_operation_count == 0
        ):
            reason = (
                f"edit-stress inventoried {page_image_brush_count} page image brush(es), "
                "but no supported lossless page image-brush operation was executed"
            )
        coverage_skip = {
            "caseId": case_id,
            "reason": reason,
            "missingExpectedDomains": missing_expected_domains,
        }
    return result, None, mutation_failure, coverage_skip


def read_and_classify_report(
    case: dict[str, Any], report_path: Path, return_code: int
) -> tuple[
    dict[str, Any] | None,
    dict[str, Any] | None,
    dict[str, Any] | None,
    dict[str, Any] | None,
]:
    try:
        report = json.loads(report_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        return None, {
            "caseId": case["id"],
            "reason": f"cannot read edit-stress report: {error}",
            "returnCode": return_code,
        }, None, None
    return classify_report(case, report, return_code)


def build_summary(
    corpus_sha256: str,
    selected_case_count: int,
    eligible_case_count: int,
    case_results: list[dict[str, Any]],
    execution_failures: list[dict[str, Any]],
    mutation_failures: list[dict[str, Any]],
    skipped_cases: list[dict[str, Any]],
    rhwp_binary_path: str | None = None,
    rhwp_binary_sha256: str | None = None,
) -> dict[str, Any]:
    failed_ids = {failure["caseId"] for failure in mutation_failures}
    skipped_ids = {skipped["caseId"] for skipped in skipped_cases}
    evaluated_results = [
        result for result in case_results if result["caseId"] not in skipped_ids
    ]
    evaluated = len(evaluated_results)
    return {
        "schemaVersion": 1,
        "corpusSha256": corpus_sha256,
        "disclaimer": DISCLAIMER,
        "rhwpBinary": {
            "path": rhwp_binary_path,
            "sha256": rhwp_binary_sha256,
        },
        "executionStatus": (
            "complete"
            if not execution_failures and not skipped_cases
            else "incomplete"
        ),
        "mutationSafetyStatus": (
            "not-evaluated"
            if not evaluated
            else "fail" if mutation_failures else "pass"
        ),
        "counts": {
            "selectedCases": selected_case_count,
            "eligibleCases": eligible_case_count,
            "evaluatedCases": evaluated,
            "passedCases": sum(
                result["caseId"] not in failed_ids for result in evaluated_results
            ),
            "mutationFailedCases": len(mutation_failures),
            "executionFailedCases": len(execution_failures),
            "skippedCases": len(skipped_cases),
            "operations": sum(result["operationCount"] for result in case_results),
            "bugs": sum(result["bugCount"] for result in case_results),
        },
        "caseResults": case_results,
        "executionFailures": execution_failures,
        "mutationFailures": mutation_failures,
        "skippedCases": skipped_cases,
    }


def summary_markdown(summary: dict[str, Any]) -> str:
    counts = summary["counts"]
    binary = summary["rhwpBinary"]
    lines = [
        "# Editing mutation-safety aggregate",
        "",
        f"> {summary['disclaimer']}",
        "",
        f"Execution status: **{summary['executionStatus'].upper()}**",
        f"Mutation-safety status: **{summary['mutationSafetyStatus'].upper()}**",
        "",
        f"- rhwp binary: `{binary['path'] or 'not recorded'}`",
        f"- rhwp binary SHA-256: `{binary['sha256'] or 'not recorded'}`",
        f"- Selected cases: {counts['selectedCases']}",
        f"- Eligible HWPX cases: {counts['eligibleCases']}",
        f"- Evaluated cases: {counts['evaluatedCases']}",
        f"- Passed cases: {counts['passedCases']}",
        f"- Mutation-failed cases: {counts['mutationFailedCases']}",
        f"- Execution-failed cases: {counts['executionFailedCases']}",
        f"- Skipped cases: {counts['skippedCases']}",
        f"- Operations: {counts['operations']}",
        f"- Bugs: {counts['bugs']}",
        "",
        "## Case results",
        "",
        "| Case | Category | Operations | Table ops | Picture ops | Layer ops | Bugs | Elapsed |",
        "| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |",
    ]
    for result in summary["caseResults"]:
        elapsed = result["elapsedMs"]
        elapsed_text = f"{elapsed} ms" if isinstance(elapsed, (int, float)) else "n/a"
        lines.append(
            f"| {result['caseId']} | {result['category']} | "
            f"{result['operationCount']} | "
            f"{result['domainCoverage']['table']['operationCount']} | "
            f"{result['domainCoverage']['picture']['operationCount']} | "
            f"{result['domainCoverage']['layered']['operationCount']} | "
            f"{result['bugCount']} | {elapsed_text} |"
        )
    for title, key in (
        ("Execution failures", "executionFailures"),
        ("Mutation failures", "mutationFailures"),
        ("Skipped cases", "skippedCases"),
    ):
        lines.extend(["", f"## {title}", ""])
        rows = summary[key]
        lines.extend(
            [f"- `{row['caseId']}`: {row['reason']}" for row in rows]
            if rows
            else ["None"]
        )
    return "\n".join(lines) + "\n"


def write_summary(out_root: Path, summary: dict[str, Any]) -> tuple[Path, Path]:
    out_root.mkdir(parents=True, exist_ok=True)
    json_path = out_root / "summary.json"
    markdown_path = out_root / "summary.md"
    json_path.write_text(
        json.dumps(summary, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    markdown_path.write_text(summary_markdown(summary), encoding="utf-8")
    return json_path, markdown_path


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    selection = parser.add_mutually_exclusive_group(required=True)
    selection.add_argument("--case", action="append", dest="case_ids")
    selection.add_argument(
        "--all-hwpx", action="store_true", help="run every eligible HWPX case"
    )
    selection.add_argument(
        "--all", action="store_true", help="select all cases and report HWP as skipped"
    )
    parser.add_argument("--rhwp-bin", type=Path)
    parser.add_argument(
        "--out",
        type=Path,
        default=(
            validate.DEFAULT_REPO_ROOT
            / "rhwp"
            / "output"
            / "editing-parity"
            / "mutation-safety"
        ),
    )
    parser.add_argument("--dry-run", action="store_true")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    validation = validate.validate_manifest()
    if not validation.ok:
        print("corpus validation failed; run validate.py for details", file=sys.stderr)
        return 1
    data = validate.load_manifest(validate.DEFAULT_MANIFEST)
    cases = data["cases"]
    by_id = {case["id"]: case for case in cases}
    if args.all:
        selected = cases
    elif args.all_hwpx:
        selected = [case for case in cases if case["source"].endswith(".hwpx")]
    else:
        selected_ids = list(dict.fromkeys(args.case_ids or []))
        unknown = [case_id for case_id in selected_ids if case_id not in by_id]
        if unknown:
            print(f"unknown case id(s): {', '.join(unknown)}", file=sys.stderr)
            return 2
        selected = [by_id[case_id] for case_id in selected_ids]

    binary = find_rhwp_binary(args.rhwp_bin)
    if binary is None:
        print(
            "rhwp binary not found; build it or pass --rhwp-bin",
            file=sys.stderr,
        )
        return 2

    eligible = [case for case in selected if case["source"].endswith(".hwpx")]
    skipped_cases = [
        {
            "caseId": case["id"],
            "reason": "rhwp edit-stress currently accepts HWPX sources only",
        }
        for case in selected
        if not case["source"].endswith(".hwpx")
    ]
    out_root = args.out.resolve()
    commands = []
    for case in eligible:
        report_path = out_root / case["id"] / "report.json"
        commands.append(
            (
                case,
                report_path,
                [
                    str(binary),
                    "edit-stress",
                    str(validate.DEFAULT_REPO_ROOT / case["source"]),
                    "-o",
                    str(report_path),
                ],
            )
        )
    if args.dry_run:
        for _, _, command in commands:
            print(shlex.join(command))
        return 0

    case_results: list[dict[str, Any]] = []
    execution_failures: list[dict[str, Any]] = []
    mutation_failures: list[dict[str, Any]] = []
    for case, report_path, command in commands:
        print(shlex.join(command), flush=True)
        try:
            completed = subprocess.run(command, check=False)
        except OSError as error:
            execution_failures.append(
                {"caseId": case["id"], "reason": f"cannot execute edit-stress: {error}"}
            )
            continue
        result, execution_failure, mutation_failure, coverage_skip = read_and_classify_report(
            case, report_path, completed.returncode
        )
        if result is not None:
            case_results.append(result)
        if execution_failure is not None:
            execution_failures.append(execution_failure)
        if mutation_failure is not None:
            mutation_failures.append(mutation_failure)
        if coverage_skip is not None:
            skipped_cases.append(coverage_skip)

    summary = build_summary(
        corpus_sha256=data["corpusSha256"],
        selected_case_count=len(selected),
        eligible_case_count=len(eligible),
        case_results=case_results,
        execution_failures=execution_failures,
        mutation_failures=mutation_failures,
        skipped_cases=skipped_cases,
        rhwp_binary_path=str(binary),
        rhwp_binary_sha256=validate.sha256_file(binary),
    )
    json_path, markdown_path = write_summary(out_root, summary)
    print(f"mutation-safety JSON: {json_path}")
    print(f"mutation-safety Markdown: {markdown_path}")
    return 0 if (
        summary["executionStatus"] == "complete"
        and summary["mutationSafetyStatus"] == "pass"
    ) else 1


if __name__ == "__main__":
    sys.exit(main())
