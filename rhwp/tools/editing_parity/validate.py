#!/usr/bin/env python3
"""Validate the immutable editing-parity corpus with the Python standard library."""

from __future__ import annotations

import argparse
from collections import Counter
from dataclasses import asdict, dataclass
import hashlib
import json
from pathlib import Path, PurePosixPath
import re
import shutil
import subprocess
import sys
from typing import Any, Callable


HERE = Path(__file__).resolve().parent
DEFAULT_MANIFEST = HERE / "corpus.json"
DEFAULT_REPO_ROOT = HERE.parents[2]

CASE_FIELDS = {
    "id",
    "category",
    "source",
    "oraclePdf",
    "sourceSha256",
    "oracleSha256",
    "oracleProvenance",
    "pageCount",
    "featureTags",
}
CATEGORIES = ("table", "picture", "layered", "mixed")
CATEGORY_QUOTAS = {"table": 16, "picture": 16, "layered": 10, "mixed": 8}
PROVENANCES = ("hancom", "diagnostic")
SHA256_RE = re.compile(r"[0-9a-f]{64}\Z")
ID_RE = re.compile(r"[a-z0-9][a-z0-9-]*\Z")


@dataclass(frozen=True)
class PdfMetadata:
    page_count: int | None
    producer: str | None
    source: str


@dataclass
class ValidationResult:
    errors: list[str]
    warnings: list[str]
    case_count: int
    page_count: int
    category_counts: dict[str, int]
    provenance_counts: dict[str, int]

    @property
    def ok(self) -> bool:
        return not self.errors

    def as_json(self) -> dict[str, Any]:
        output = asdict(self)
        output["ok"] = self.ok
        return {"ok": output.pop("ok"), **output}


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def corpus_sha256(cases: list[Any]) -> str:
    canonical = json.dumps(
        cases,
        ensure_ascii=False,
        separators=(",", ":"),
        sort_keys=True,
    ).encode("utf-8")
    return hashlib.sha256(canonical).hexdigest()


def inspect_pdf(path: Path) -> PdfMetadata:
    """Read portable PDF metadata when the optional pdfinfo executable is present."""
    binary = shutil.which("pdfinfo")
    if binary is None:
        return PdfMetadata(None, None, "unavailable")
    try:
        completed = subprocess.run(
            [binary, str(path)],
            capture_output=True,
            check=False,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=30,
        )
    except (OSError, subprocess.TimeoutExpired):
        return PdfMetadata(None, None, "unavailable")
    if completed.returncode != 0:
        return PdfMetadata(None, None, "unavailable")
    fields: dict[str, str] = {}
    for line in completed.stdout.splitlines():
        if ":" not in line:
            continue
        key, value = line.split(":", 1)
        fields[key.strip().lower()] = value.strip()
    pages = fields.get("pages", "")
    page_count = int(pages) if pages.isdigit() else None
    return PdfMetadata(page_count, fields.get("producer") or None, "pdfinfo")


def _contained_path(
    repo_root: Path,
    raw_path: Any,
    allowed_root: Path,
    field: str,
    case_id: str,
    errors: list[str],
) -> Path | None:
    if not isinstance(raw_path, str) or not raw_path:
        errors.append(f"{case_id}: {field} must be a nonempty relative path")
        return None
    posix_path = PurePosixPath(raw_path)
    if posix_path.is_absolute() or ".." in posix_path.parts or "\\" in raw_path:
        errors.append(f"{case_id}: {field} must be a contained POSIX path")
        return None
    candidate = (repo_root / Path(*posix_path.parts)).resolve()
    try:
        candidate.relative_to(allowed_root.resolve())
    except ValueError:
        errors.append(f"{case_id}: {field} escapes {allowed_root.relative_to(repo_root)}")
        return None
    if not candidate.is_file():
        errors.append(f"{case_id}: {field} does not exist: {raw_path}")
        return None
    return candidate


def validate_manifest_data(
    data: Any,
    repo_root: Path,
    pdf_inspector: Callable[[Path], PdfMetadata] = inspect_pdf,
) -> ValidationResult:
    errors: list[str] = []
    warning_set: set[str] = set()
    repo_root = repo_root.resolve()

    if not isinstance(data, dict):
        return ValidationResult(
            ["manifest root must be an object"], [], 0, 0, {}, {}
        )

    expected_top_fields = {"schemaVersion", "caseType", "corpusSha256", "cases"}
    actual_top_fields = set(data)
    if actual_top_fields != expected_top_fields:
        missing = sorted(expected_top_fields - actual_top_fields)
        extra = sorted(actual_top_fields - expected_top_fields)
        if missing:
            errors.append(f"manifest missing fields: {', '.join(missing)}")
        if extra:
            errors.append(f"manifest has unknown fields: {', '.join(extra)}")
    if data.get("schemaVersion") != 1:
        errors.append("schemaVersion must be 1")
    if data.get("caseType") != "EditingParityCase":
        errors.append("caseType must be EditingParityCase")

    cases = data.get("cases")
    if not isinstance(cases, list):
        errors.append("cases must be an array")
        cases = []
    if len(cases) != 50:
        errors.append(f"cases must contain exactly 50 entries, found {len(cases)}")

    pinned_corpus_sha = data.get("corpusSha256")
    if not isinstance(pinned_corpus_sha, str) or not SHA256_RE.fullmatch(pinned_corpus_sha):
        errors.append("corpusSha256 must be a lowercase SHA-256")
    elif corpus_sha256(cases) != pinned_corpus_sha:
        errors.append("corpusSha256 mismatch; ordered corpus content changed")

    categories: Counter[str] = Counter()
    provenances: Counter[str] = Counter()
    seen_ids: set[str] = set()
    seen_sources: set[str] = set()
    seen_source_hashes: dict[str, str] = {}
    seen_oracles: set[str] = set()
    total_pages = 0
    hash_cache: dict[Path, str] = {}
    sample_root = repo_root / "rhwp" / "samples"
    oracle_root = repo_root / "rhwp" / "pdf"

    for index, raw_case in enumerate(cases):
        label = f"cases[{index}]"
        if not isinstance(raw_case, dict):
            errors.append(f"{label}: case must be an object")
            continue
        case_id = raw_case.get("id")
        if isinstance(case_id, str) and case_id:
            label = case_id
        if set(raw_case) != CASE_FIELDS:
            missing = sorted(CASE_FIELDS - set(raw_case))
            extra = sorted(set(raw_case) - CASE_FIELDS)
            if missing:
                errors.append(f"{label}: missing fields: {', '.join(missing)}")
            if extra:
                errors.append(f"{label}: unknown fields: {', '.join(extra)}")

        if not isinstance(case_id, str) or not ID_RE.fullmatch(case_id):
            errors.append(f"{label}: id must use lowercase letters, digits, and hyphens")
        elif case_id in seen_ids:
            errors.append(f"{label}: duplicate id")
        else:
            seen_ids.add(case_id)

        category = raw_case.get("category")
        if category not in CATEGORIES:
            errors.append(f"{label}: invalid category {category!r}")
        else:
            categories[category] += 1

        provenance = raw_case.get("oracleProvenance")
        if provenance not in PROVENANCES:
            errors.append(f"{label}: invalid oracleProvenance {provenance!r}")
        else:
            provenances[provenance] += 1

        tags = raw_case.get("featureTags")
        if (
            not isinstance(tags, list)
            or not tags
            or any(not isinstance(tag, str) or not tag.strip() for tag in tags)
        ):
            errors.append(f"{label}: featureTags must contain nonempty strings")
        elif len(tags) != len(set(tags)):
            errors.append(f"{label}: featureTags must be unique")

        page_count = raw_case.get("pageCount")
        if not isinstance(page_count, int) or isinstance(page_count, bool) or page_count < 1:
            errors.append(f"{label}: pageCount must be a positive integer")
            page_count = 0
        total_pages += page_count

        source_value = raw_case.get("source")
        oracle_value = raw_case.get("oraclePdf")
        if isinstance(source_value, str):
            if source_value in seen_sources:
                errors.append(f"{label}: duplicate source path")
            seen_sources.add(source_value)
        if isinstance(oracle_value, str):
            if oracle_value in seen_oracles:
                errors.append(f"{label}: duplicate oraclePdf path")
            seen_oracles.add(oracle_value)

        source = _contained_path(
            repo_root, source_value, sample_root, "source", label, errors
        )
        oracle = _contained_path(
            repo_root, oracle_value, oracle_root, "oraclePdf", label, errors
        )
        if source is not None and source.suffix.lower() not in {".hwp", ".hwpx"}:
            errors.append(f"{label}: source must be HWP or HWPX")
        if oracle is not None and oracle.suffix.lower() != ".pdf":
            errors.append(f"{label}: oraclePdf must be PDF")

        for field, path in (
            ("sourceSha256", source),
            ("oracleSha256", oracle),
        ):
            pinned_hash = raw_case.get(field)
            if not isinstance(pinned_hash, str) or not SHA256_RE.fullmatch(pinned_hash):
                errors.append(f"{label}: {field} must be a lowercase SHA-256")
                continue
            if field == "sourceSha256":
                previous = seen_source_hashes.get(pinned_hash)
                if previous is not None:
                    errors.append(
                        f"{label}: duplicate sourceSha256 also used by {previous}"
                    )
                else:
                    seen_source_hashes[pinned_hash] = label
            if path is None:
                continue
            actual_hash = hash_cache.setdefault(path, sha256_file(path))
            if actual_hash != pinned_hash:
                errors.append(f"{label}: {field} mismatch")

        if oracle is not None:
            metadata = pdf_inspector(oracle)
            if metadata.page_count is None:
                warning_set.add("PDF page-count checks skipped because pdfinfo is unavailable")
            elif page_count and metadata.page_count != page_count:
                errors.append(
                    f"{label}: pageCount mismatch, expected {page_count}, found {metadata.page_count}"
                )
            producer = metadata.producer
            if producer is None:
                warning_set.add("PDF producer checks skipped because pdfinfo is unavailable")
            elif provenance == "hancom" and "hancom" not in producer.lower():
                errors.append(
                    f"{label}: hancom provenance requires a Hancom PDF producer, found {producer!r}"
                )
            elif provenance == "diagnostic" and "hancom" in producer.lower():
                errors.append(
                    f"{label}: diagnostic provenance cannot use a Hancom PDF producer"
                )

    actual_quotas = {category: categories.get(category, 0) for category in CATEGORIES}
    if actual_quotas != CATEGORY_QUOTAS:
        errors.append(
            "category quotas must be "
            + ", ".join(f"{key}={value}" for key, value in CATEGORY_QUOTAS.items())
        )

    return ValidationResult(
        errors=errors,
        warnings=sorted(warning_set),
        case_count=len(cases),
        page_count=total_pages,
        category_counts=actual_quotas,
        provenance_counts={
            provenance: provenances.get(provenance, 0) for provenance in PROVENANCES
        },
    )


def load_manifest(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def validate_manifest(
    manifest_path: Path = DEFAULT_MANIFEST,
    repo_root: Path = DEFAULT_REPO_ROOT,
    pdf_inspector: Callable[[Path], PdfMetadata] = inspect_pdf,
) -> ValidationResult:
    try:
        data = load_manifest(manifest_path)
    except (OSError, json.JSONDecodeError) as error:
        return ValidationResult([f"cannot read manifest: {error}"], [], 0, 0, {}, {})
    return validate_manifest_data(data, repo_root, pdf_inspector)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", type=Path, default=DEFAULT_MANIFEST)
    parser.add_argument("--repo-root", type=Path, default=DEFAULT_REPO_ROOT)
    parser.add_argument("--json", action="store_true", help="emit machine-readable JSON")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    result = validate_manifest(args.manifest.resolve(), args.repo_root.resolve())
    if args.json:
        print(json.dumps(result.as_json(), ensure_ascii=False, sort_keys=True))
    elif result.ok:
        categories = " ".join(
            f"{key}={result.category_counts.get(key, 0)}" for key in CATEGORIES
        )
        provenances = " ".join(
            f"{key}={result.provenance_counts.get(key, 0)}" for key in PROVENANCES
        )
        print(
            f"OK editing parity corpus: {result.case_count} cases, "
            f"{result.page_count} pages"
        )
        print(f"categories: {categories}")
        print(f"provenance: {provenances}")
        for warning in result.warnings:
            print(f"warning: {warning}")
    else:
        print(f"INVALID editing parity corpus: {len(result.errors)} error(s)")
        for error in result.errors:
            print(f"- {error}")
        for warning in result.warnings:
            print(f"warning: {warning}")
    return 0 if result.ok else 1


if __name__ == "__main__":
    sys.exit(main())
