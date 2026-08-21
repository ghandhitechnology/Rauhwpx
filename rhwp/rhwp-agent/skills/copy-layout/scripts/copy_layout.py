#!/usr/bin/env python3
"""Create a content-free HWP or HWPX while preserving layout-bearing structure."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import unicodedata
import zipfile
from collections import Counter
from copy import deepcopy
from pathlib import Path, PurePosixPath

try:
    from lxml import etree
except ImportError as exc:  # pragma: no cover - dependency check is user-facing
    raise SystemExit("copy-layout requires Python package 'lxml'") from exc


OPF_NS = "http://www.idpf.org/2007/opf/"
LAYOUT_ANCESTORS = {
    "background",
    "footer",
    "header",
    "masterPage",
    "pageBorderFill",
    "pagePr",
    "secPr",
}
TEXT_ELEMENTS = {"t", "shapeComment"}
TEXT_MARKUP_REMOVE = {"markpenBegin", "markpenEnd"}
FIELD_ELEMENTS = {"fieldBegin", "fieldEnd"}
PRIVATE_ATTRS = {"description", "href", "name", "title"}
PAYLOAD_PREFIXES = (
    "Annotations/",
    "Chart/",
    "Comments/",
    "DocHistory/",
    "History/",
    "Preview/",
    "Scripts/",
)
GEOMETRY_ELEMENTS = {
    "cellAddr",
    "cellMargin",
    "cellSpan",
    "cellSz",
    "colPr",
    "container",
    "curve",
    "ellipse",
    "fillBrush",
    "footerPr",
    "headerPr",
    "line",
    "lineShape",
    "masterPage",
    "ole",
    "outMargin",
    "pageBorderFill",
    "pagePr",
    "pic",
    "polygon",
    "pos",
    "rect",
    "secPr",
    "shapeComponent",
    "sz",
    "tbl",
    "tc",
    "textMargin",
    "tr",
}
OBJECT_ELEMENTS = {
    "connectLine",
    "container",
    "curve",
    "ellipse",
    "equation",
    "line",
    "ole",
    "pic",
    "polygon",
    "rect",
    "tbl",
    "textart",
}


def local_name(value: str) -> str:
    return value.rsplit("}", 1)[-1]


def blank_text(value: str | None) -> str | None:
    if value is None:
        return None
    return "".join(
        character
        if character.isspace()
        else "\u3000"
        if unicodedata.east_asian_width(character) in {"W", "F"}
        else " "
        for character in value
    )


def parse_xml(data: bytes, part: str) -> etree._ElementTree:
    parser = etree.XMLParser(
        remove_blank_text=False,
        resolve_entities=False,
        no_network=True,
        strip_cdata=False,
        huge_tree=True,
    )
    try:
        return etree.fromstring(data, parser=parser).getroottree()
    except etree.XMLSyntaxError as exc:
        raise ValueError(f"invalid XML in {part}: {exc}") from exc


def serialize_xml(tree: etree._ElementTree, original: bytes) -> bytes:
    standalone = True if re.search(br"standalone\s*=\s*['\"]yes['\"]", original[:256]) else None
    return etree.tostring(
        tree,
        encoding="UTF-8",
        xml_declaration=True,
        standalone=standalone,
        pretty_print=False,
    )


def is_xml_part(name: str) -> bool:
    return PurePosixPath(name).suffix.lower() in {".xml", ".hpf", ".rdf"}


def is_document_xml(name: str) -> bool:
    path = PurePosixPath(name)
    return (
        name == "Contents/header.xml"
        or (path.parent == PurePosixPath("Contents") and path.name.startswith("section"))
        or (path.parent == PurePosixPath("Contents") and path.name.startswith("masterpage"))
    )


def manifest_map(tree: etree._ElementTree) -> dict[str, str]:
    result: dict[str, str] = {}
    for item in tree.xpath("//*[local-name()='manifest']/*[local-name()='item']"):
        item_id = item.get("id")
        href = item.get("href")
        if item_id and href:
            result[item_id] = href.lstrip("/")
    return result


def element_is_layout_media(element: etree._Element, part: str) -> bool:
    path = PurePosixPath(part)
    if path.parent == PurePosixPath("Contents") and path.name.startswith("masterpage"):
        return True
    if part == "Contents/header.xml":
        return True
    current: etree._Element | None = element
    while current is not None:
        if local_name(current.tag) in LAYOUT_ANCESTORS:
            return True
        current = current.getparent()
    return False


def collect_media_uses(
    trees: dict[str, etree._ElementTree],
) -> tuple[dict[str, list[str]], dict[str, list[str]]]:
    layout: dict[str, list[str]] = {}
    body: dict[str, list[str]] = {}
    for part, tree in trees.items():
        if not is_document_xml(part):
            continue
        for element in tree.iter():
            for attr_name, value in element.attrib.items():
                if local_name(attr_name) != "binaryItemIDRef" or not value:
                    continue
                bucket = layout if element_is_layout_media(element, part) else body
                bucket.setdefault(value, []).append(f"{part}:{local_name(element.tag)}")
    return layout, body


def remove_field_markers(root: etree._Element) -> int:
    removed = 0
    for element in list(root.iter()):
        if local_name(element.tag) not in FIELD_ELEMENTS:
            continue
        parent = element.getparent()
        if parent is not None:
            parent.remove(element)
            removed += 1
    return removed


def infer_rendered_page_breaks(root: etree._Element, limit: int) -> int:
    """Make HWPX line-position page resets explicit before HWP conversion."""
    added = 0
    previous_last_position: int | None = None
    for paragraph in root:
        if local_name(paragraph.tag) != "p":
            continue
        positions = [
            int(segment.get("vertpos", "0"))
            for segment in paragraph.iter()
            if local_name(segment.tag) == "lineseg"
        ]
        if not positions:
            continue
        if (
            added < limit
            and previous_last_position is not None
            and positions[0] < previous_last_position
            and paragraph.get("pageBreak") != "1"
        ):
            paragraph.set("pageBreak", "1")
            added += 1
        previous_last_position = positions[-1]
    return added


def sanitize_document_tree(
    tree: etree._ElementTree,
    part: str,
    removable_media: set[str],
    preserve_flow: bool,
) -> dict[str, int]:
    stats = Counter()
    root = tree.getroot()
    stats["field_markers_removed"] += remove_field_markers(root)

    # Snapshot first: clearing inline children while walking a live lxml iterator
    # can skip later sibling runs in long paragraphs.
    for element in list(root.iter()):
        tag = local_name(element.tag)
        if tag in TEXT_ELEMENTS:
            if element.text or len(element):
                stats["text_nodes_cleared"] += 1
            element.text = blank_text(element.text) if tag == "t" and preserve_flow else None
            for child in list(element):
                child.tail = blank_text(child.tail) if tag == "t" and preserve_flow else None
                if tag == "shapeComment" or local_name(child.tag) in TEXT_MARKUP_REMOVE:
                    element.remove(child)
        elif tag == "script" and any(
            local_name(parent.tag) == "equation" for parent in element.iterancestors()
        ):
            if element.text:
                stats["equations_cleared"] += 1
            element.text = None

        for attr_name in list(element.attrib):
            attr = local_name(attr_name)
            value = element.get(attr_name, "")
            if attr == "binaryItemIDRef" and value in removable_media:
                element.set(attr_name, "")
                stats["media_references_cleared"] += 1
            elif attr in PRIVATE_ATTRS and value:
                element.set(attr_name, "")
                stats["private_attributes_cleared"] += 1
            elif tag in {"formObject", "fieldBegin"} and attr in {"caption", "text", "value"} and value:
                element.set(attr_name, "")
                stats["form_values_cleared"] += 1
    return dict(stats)


def sanitize_metadata(tree: etree._ElementTree, title: str) -> dict[str, int]:
    stats = Counter()
    metadata_nodes = tree.xpath("//*[local-name()='metadata']")
    for metadata in metadata_nodes:
        title_nodes = metadata.xpath("./*[local-name()='title']")
        if title_nodes:
            for node in title_nodes:
                node.text = title
        else:
            node = etree.Element(f"{{{OPF_NS}}}title")
            node.text = title
            metadata.insert(0, node)
        for child in metadata:
            child_name = local_name(child.tag)
            if child_name in {"title", "language"}:
                continue
            if child.text or any(value for value in child.attrib.values()):
                stats["metadata_values_cleared"] += 1
            child.text = None
            for attr_name in list(child.attrib):
                if local_name(attr_name) not in {"name"}:
                    child.set(attr_name, "")
    return dict(stats)


def scrub_manifest(
    tree: etree._ElementTree,
    removed_parts: set[str],
) -> int:
    removed_ids: set[str] = set()
    removed = 0
    for item in list(tree.xpath("//*[local-name()='manifest']/*[local-name()='item']")):
        href = (item.get("href") or "").lstrip("/")
        if href not in removed_parts:
            continue
        item_id = item.get("id")
        if item_id:
            removed_ids.add(item_id)
        parent = item.getparent()
        if parent is not None:
            parent.remove(item)
            removed += 1
    for itemref in list(tree.xpath("//*[local-name()='spine']/*[local-name()='itemref']")):
        if itemref.get("idref") in removed_ids:
            parent = itemref.getparent()
            if parent is not None:
                parent.remove(itemref)
    return removed


def output_path_for(source: Path, requested: Path | None) -> tuple[Path, str]:
    title = f"{source.stem} - Layout"
    suffix = source.suffix.lower()
    candidate = requested if requested else source.parent / "layout" / f"{title}{suffix}"
    candidate = candidate.expanduser().resolve()
    if candidate.suffix.lower() not in {".hwp", ".hwpx"}:
        raise ValueError("output path must end in .hwp or .hwpx")
    if candidate == source.resolve():
        raise ValueError("refusing to overwrite the source document")
    if candidate.exists():
        if requested:
            raise FileExistsError(f"output already exists: {candidate}")
        index = 2
        while candidate.exists():
            candidate = source.parent / "layout" / f"{title} ({index}){suffix}"
            index += 1
        candidate = candidate.resolve()
    return candidate, title


def available_fallback_path(destination: Path) -> Path:
    candidate = destination.with_suffix(".hwpx")
    index = 2
    while candidate.exists():
        candidate = destination.with_name(f"{destination.stem} ({index}).hwpx")
        index += 1
    return candidate


def cleaned_geometry_xml(element: etree._Element) -> bytes:
    clone = deepcopy(element)
    for node in list(clone.iter()):
        tag = local_name(node.tag)
        if tag in FIELD_ELEMENTS:
            parent = node.getparent()
            if parent is not None:
                parent.remove(node)
            continue
        if tag in TEXT_ELEMENTS or tag == "script":
            node.text = None
            for child in list(node):
                child.tail = None
                if tag == "shapeComment" or local_name(child.tag) in TEXT_MARKUP_REMOVE:
                    node.remove(child)
        for attr_name in list(node.attrib):
            if local_name(attr_name) in PRIVATE_ATTRS | {"binaryItemIDRef"}:
                node.set(attr_name, "")
    return etree.tostring(clone, method="c14n", with_comments=False)


def layout_fingerprint(trees: dict[str, etree._ElementTree]) -> dict[str, object]:
    digest = hashlib.sha256()
    counts: Counter[str] = Counter()
    sections = 0
    for part in sorted(trees):
        if not is_document_xml(part):
            continue
        if PurePosixPath(part).name.startswith("section"):
            sections += 1
        root = trees[part].getroot()
        for element in root.iter():
            tag = local_name(element.tag)
            if tag in OBJECT_ELEMENTS:
                counts[tag] += 1
            if tag in GEOMETRY_ELEMENTS:
                digest.update(part.encode("utf-8"))
                digest.update(cleaned_geometry_xml(element))
    return {
        "sections": sections,
        "objects": dict(sorted(counts.items())),
        "geometry_sha256": digest.hexdigest(),
    }


def write_archive(
    source: Path,
    output: Path,
    original_infos: list[zipfile.ZipInfo],
    entries: dict[str, bytes],
) -> None:
    output.parent.mkdir(parents=True, exist_ok=True)
    try:
        with zipfile.ZipFile(output, "w") as archive:
            names = [info.filename for info in original_infos if info.filename in entries]
            if "mimetype" in names:
                names.remove("mimetype")
                names.insert(0, "mimetype")
            info_by_name = {info.filename: info for info in original_infos}
            for name in names:
                info = info_by_name[name]
                if name == "mimetype":
                    info.compress_type = zipfile.ZIP_STORED
                archive.writestr(info, entries[name])
    except Exception:
        output.unlink(missing_ok=True)
        raise


def validate_output(
    output: Path,
    expected_title: str | None,
    source_fingerprint: dict[str, object],
    allow_generated_preview: bool = False,
    require_geometry_hash: bool = True,
) -> dict[str, object]:
    with zipfile.ZipFile(output) as archive:
        bad = archive.testzip()
        if bad:
            raise ValueError(f"corrupt ZIP entry: {bad}")
        names = archive.namelist()
        if not names or names[0] != "mimetype":
            raise ValueError("mimetype is not the first package entry")
        if archive.getinfo("mimetype").compress_type != zipfile.ZIP_STORED:
            raise ValueError("mimetype must be stored without compression")
        if archive.read("mimetype").strip() != b"application/hwp+zip":
            raise ValueError("unexpected HWPX mimetype")

        trees: dict[str, etree._ElementTree] = {}
        leaked_text: list[str] = []
        for name in names:
            if is_xml_part(name):
                trees[name] = parse_xml(archive.read(name), name)
            if is_document_xml(name):
                tree = trees[name]
                for element in tree.iter():
                    if local_name(element.tag) in TEXT_ELEMENTS and "".join(element.itertext()).strip():
                        leaked_text.append(f"{name}:{local_name(element.tag)}")

        if leaked_text:
            raise ValueError(f"visible text remains: {', '.join(leaked_text[:5])}")
        forbidden_prefixes = tuple(
            prefix
            for prefix in PAYLOAD_PREFIXES
            if not (allow_generated_preview and prefix == "Preview/")
        )
        if any(name.startswith(forbidden_prefixes) for name in names):
            raise ValueError("preview, script, annotation, history, or chart payload remains")

        content_tree = trees.get("Contents/content.hpf")
        if content_tree is None:
            raise ValueError("Contents/content.hpf is missing")
        titles = content_tree.xpath("//*[local-name()='metadata']/*[local-name()='title']/text()")
        if expected_title is not None and titles != [expected_title]:
            raise ValueError(f"document title mismatch: {titles!r}")

        output_fingerprint = layout_fingerprint(trees)
        if require_geometry_hash:
            if output_fingerprint != source_fingerprint:
                raise ValueError("layout geometry fingerprint changed")
        elif any(
            output_fingerprint.get(key) != source_fingerprint.get(key)
            for key in ("sections", "objects")
        ):
            raise ValueError("layout section or object inventory changed")
        verification = {
            "zip_valid": True,
            "xml_valid": True,
            "visible_text_nodes": 0,
            "title": titles[0] if titles else None,
            "layout_structure_match": True,
            "layout": output_fingerprint,
        }
        if require_geometry_hash:
            verification["layout_fingerprint_match"] = True
        return verification


def sanitize_hwpx(
    source: Path,
    destination: Path,
    title: str,
    keep_media: set[str],
    preserve_flow: bool = True,
) -> dict[str, object]:
    with zipfile.ZipFile(source) as archive:
        if archive.testzip():
            raise ValueError("source HWPX contains a corrupt ZIP entry")
        infos = archive.infolist()
        entries = {info.filename: archive.read(info.filename) for info in infos}

    trees = {
        name: parse_xml(data, name)
        for name, data in entries.items()
        if is_xml_part(name)
    }
    content_tree = trees.get("Contents/content.hpf")
    if content_tree is None:
        raise ValueError("source is missing Contents/content.hpf")

    source_fingerprint = layout_fingerprint(trees)
    items = manifest_map(content_tree)
    layout_uses, body_uses = collect_media_uses(trees)
    known_media = {
        item_id
        for item_id, href in items.items()
        if href.startswith("BinData/") or href.startswith("Chart/")
    }
    unknown_keep = keep_media - known_media
    if unknown_keep:
        raise ValueError(f"unknown media id(s): {', '.join(sorted(unknown_keep))}")
    protected_media = set(layout_uses) | keep_media
    removable_media = known_media - protected_media

    removed_parts = {
        name
        for name in entries
        if name.startswith(PAYLOAD_PREFIXES)
    }
    for item_id in removable_media:
        href = items.get(item_id)
        if href:
            removed_parts.add(href)

    totals = Counter()
    for part, tree in trees.items():
        if is_document_xml(part):
            totals.update(sanitize_document_tree(tree, part, removable_media, preserve_flow))
    totals.update(sanitize_metadata(content_tree, title))
    totals["manifest_items_removed"] += scrub_manifest(content_tree, removed_parts)

    for part, tree in trees.items():
        if part not in removed_parts:
            entries[part] = serialize_xml(tree, entries[part])
    for part in removed_parts:
        entries.pop(part, None)

    write_archive(source, destination, infos, entries)
    try:
        verification = validate_output(destination, title, source_fingerprint)
    except Exception:
        destination.unlink(missing_ok=True)
        raise
    return {
        "source": str(source),
        "output": str(destination),
        "title": title,
        "kept_layout_media": sorted(layout_uses),
        "kept_explicit_media": sorted(keep_media),
        "removed_body_media": sorted(removable_media & set(body_uses)),
        "removed_unreferenced_media": sorted(removable_media - set(body_uses)),
        "media_usage": {"layout": layout_uses, "body": body_uses},
        "changes": dict(totals),
        "text_strategy": "width-aware blank spacing" if preserve_flow else "fully empty",
        "verification": verification,
    }


def add_page_break_hints(
    source: Path,
    output: Path,
    count: int,
    title: str,
    expected_fingerprint: dict[str, object],
) -> int:
    with zipfile.ZipFile(source) as archive:
        infos = archive.infolist()
        entries = {info.filename: archive.read(info.filename) for info in infos}
    remaining = count
    added = 0
    for part in sorted(entries):
        if remaining == 0 or not PurePosixPath(part).name.startswith("section"):
            continue
        if not is_xml_part(part):
            continue
        tree = parse_xml(entries[part], part)
        part_added = infer_rendered_page_breaks(tree.getroot(), remaining)
        if part_added:
            entries[part] = serialize_xml(tree, entries[part])
            added += part_added
            remaining -= part_added
    if remaining:
        raise ValueError(f"could not infer {remaining} required page break(s)")
    write_archive(source, output, infos, entries)
    try:
        validate_output(output, title, expected_fingerprint)
    except Exception:
        output.unlink(missing_ok=True)
        raise
    return added


def resolve_rhwp_binary(requested: Path | None) -> Path:
    candidates: list[Path] = []
    if requested:
        candidates.append(requested.expanduser())
    env_binary = os.environ.get("RHWP_BIN")
    if env_binary:
        candidates.append(Path(env_binary).expanduser())
    path_binary = shutil.which("rhwp")
    if path_binary:
        candidates.append(Path(path_binary))
    repository_root = Path(__file__).resolve().parents[4]
    candidates.extend(
        [
            repository_root / "target" / "release" / "rhwp",
            repository_root / "target" / "debug" / "rhwp",
        ]
    )
    for candidate in candidates:
        resolved = candidate.resolve()
        if resolved.is_file() and os.access(resolved, os.X_OK):
            return resolved
    raise ValueError(
        "HWP support requires the Rauhwpx 'rhwp' binary; pass --rhwp-bin, "
        "set RHWP_BIN, add rhwp to PATH, or build it with cargo build"
    )


class RhwpCommandError(ValueError):
    """A failed rhwp subprocess with its stable CLI exit code preserved."""

    def __init__(self, command: str, returncode: int, detail: str):
        super().__init__(f"rhwp {command} failed: {detail}")
        self.returncode = returncode


def run_rhwp(binary: Path, arguments: list[str], expect_json: bool = False) -> object:
    command = [str(binary), *arguments]
    result = subprocess.run(command, capture_output=True, text=True, check=False)
    if result.returncode != 0:
        detail = result.stderr.strip() or result.stdout.strip() or "no diagnostic output"
        raise RhwpCommandError(" ".join(arguments[:1]), result.returncode, detail)
    if not expect_json:
        return result.stdout.strip()
    try:
        return json.loads(result.stdout)
    except json.JSONDecodeError as exc:
        raise ValueError(f"rhwp {' '.join(arguments[:1])} returned invalid JSON") from exc


def native_document_info(binary: Path, document: Path) -> dict[str, object]:
    payload = run_rhwp(binary, ["info", str(document), "--json"], expect_json=True)
    if not isinstance(payload, dict):
        raise ValueError("rhwp info returned an unexpected JSON value")
    return payload


def export_hwpx_for_sanitization(
    binary: Path,
    source: Path,
    output: Path,
) -> dict[str, object]:
    """Export an intermediate HWPX while deferring only the page-count gate.

    The intermediate is never delivered. A page-count mismatch can disappear
    after source text is removed, so final HWP/HWPX verification remains the
    authoritative quality gate. All other export failures stay fatal.
    """
    try:
        run_rhwp(
            binary,
            ["export-hwpx", str(source), str(output), "--verify-pages"],
        )
        return {"page_gate": "passed"}
    except RhwpCommandError as exc:
        if exc.returncode != 4:
            raise
        output.unlink(missing_ok=True)
        run_rhwp(binary, ["export-hwpx", str(source), str(output)])
        source_pages = native_document_info(binary, source).get("pageCount")
        intermediate_pages = native_document_info(binary, output).get("pageCount")
        return {
            "page_gate": "deferred-to-final-output",
            "source_page_count": source_pages,
            "intermediate_page_count": intermediate_pages,
            "reason": str(exc),
        }


def verify_native_output(
    binary: Path,
    source: Path,
    output: Path,
    title: str,
    expected_fingerprint: dict[str, object],
    sanitized_hwpx: Path,
    roundtrip_hwpx: Path,
) -> dict[str, object]:
    source_info = native_document_info(binary, source)
    output_info = native_document_info(binary, output)
    for key in ("pageCount", "sections"):
        if source_info.get(key) != output_info.get(key):
            raise ValueError(
                f"native {key} changed: {source_info.get(key)!r} -> {output_info.get(key)!r}"
            )

    expected_text_payload = run_rhwp(
        binary,
        ["export-text", str(sanitized_hwpx), "--json"],
        expect_json=True,
    )
    text_payload = run_rhwp(binary, ["export-text", str(output), "--json"], expect_json=True)
    if (
        not isinstance(expected_text_payload, dict)
        or not isinstance(expected_text_payload.get("pages"), list)
        or not isinstance(text_payload, dict)
        or not isinstance(text_payload.get("pages"), list)
    ):
        raise ValueError("rhwp export-text returned an unexpected JSON value")
    expected_tokens = [
        re.findall(r"\S+", str(page.get("text", "")))
        for page in expected_text_payload["pages"]
        if isinstance(page, dict)
    ]
    output_tokens = [
        re.findall(r"\S+", str(page.get("text", "")))
        for page in text_payload["pages"]
        if isinstance(page, dict)
    ]
    if output_tokens != expected_tokens:
        raise ValueError("native output introduced or changed generated layout text")

    render_diff = run_rhwp(
        binary,
        ["render-diff", str(sanitized_hwpx), str(output), "--max-disp", "0.5"],
    )

    run_rhwp(
        binary,
        ["export-hwpx", str(output), str(roundtrip_hwpx), "--verify-pages"],
    )
    # export-hwpx regenerates a preview from the already-sanitized HWP. It is
    # safe to ignore here because export-text above independently proved the
    # native document has no visible text, while all other payload classes
    # remain forbidden.
    roundtrip = validate_output(
        roundtrip_hwpx,
        None,
        expected_fingerprint,
        allow_generated_preview=True,
        require_geometry_hash=False,
    )
    return {
        "format": output_info.get("format"),
        "page_count": output_info.get("pageCount"),
        "sections": output_info.get("sections"),
        "content_text_nodes": 0,
        "generated_layout_text_matches": True,
        "title": title,
        "title_verified_by": "output filename",
        "render_diff": render_diff,
        "roundtrip_hwpx": roundtrip,
    }


def copy_layout(
    source: Path,
    output: Path | None,
    keep_media: set[str],
    rhwp_binary: Path | None = None,
) -> dict[str, object]:
    output_was_requested = output is not None
    source = source.expanduser().resolve()
    source_format = source.suffix.lower()
    if not source.is_file() or source_format not in {".hwp", ".hwpx"}:
        raise ValueError(f"source is not an HWP or HWPX file: {source}")
    destination, title = output_path_for(source, output)
    output_format = destination.suffix.lower()

    if source_format == ".hwpx" and output_format == ".hwpx":
        report = sanitize_hwpx(source, destination, title, keep_media)
        report.update(
            {
                "source": str(source),
                "output": str(destination),
                "input_format": "hwpx",
                "output_format": "hwpx",
                "conversion": None,
            }
        )
        return report

    binary = resolve_rhwp_binary(rhwp_binary)
    destination.parent.mkdir(parents=True, exist_ok=True)
    try:
        with tempfile.TemporaryDirectory(prefix="copy-layout-") as temporary_directory:
            temporary = Path(temporary_directory)
            intermediate_export: dict[str, object] | None = None
            if source_format == ".hwp":
                source_hwpx = temporary / "source.hwpx"
                intermediate_export = export_hwpx_for_sanitization(
                    binary,
                    source,
                    source_hwpx,
                )
            else:
                source_hwpx = source

            sanitized_hwpx = destination if output_format == ".hwpx" else temporary / "layout.hwpx"
            report = sanitize_hwpx(
                source_hwpx,
                sanitized_hwpx,
                title,
                keep_media,
                preserve_flow=False,
            )
            native_verification: dict[str, object] | None = None
            if output_format == ".hwp":
                run_rhwp(
                    binary,
                    ["convert", str(sanitized_hwpx), str(destination), "--verify-pages"],
                )
                source_page_count = native_document_info(binary, source).get("pageCount")
                output_page_count = native_document_info(binary, destination).get("pageCount")
                if (
                    isinstance(source_page_count, int)
                    and isinstance(output_page_count, int)
                    and output_page_count < source_page_count
                ):
                    flow_preserved_hwpx = temporary / "layout-flow-preserved.hwpx"
                    report = sanitize_hwpx(
                        source_hwpx,
                        flow_preserved_hwpx,
                        title,
                        keep_media,
                        preserve_flow=True,
                    )
                    sanitized_hwpx = flow_preserved_hwpx
                    destination.unlink(missing_ok=True)
                    run_rhwp(
                        binary,
                        ["convert", str(sanitized_hwpx), str(destination), "--verify-pages"],
                    )
                    output_page_count = native_document_info(binary, destination).get("pageCount")
                if (
                    isinstance(source_page_count, int)
                    and isinstance(output_page_count, int)
                    and output_page_count < source_page_count
                ):
                    page_hints = temporary / "layout-with-page-breaks.hwpx"
                    added = add_page_break_hints(
                        sanitized_hwpx,
                        page_hints,
                        source_page_count - output_page_count,
                        title,
                        report["verification"]["layout"],
                    )
                    report["changes"]["inferred_page_breaks"] = added
                    destination.unlink(missing_ok=True)
                    sanitized_hwpx = page_hints
                    run_rhwp(
                        binary,
                        ["convert", str(sanitized_hwpx), str(destination), "--verify-pages"],
                    )
                try:
                    native_verification = verify_native_output(
                        binary,
                        source,
                        destination,
                        title,
                        report["verification"]["layout"],
                        sanitized_hwpx,
                        temporary / "roundtrip.hwpx",
                    )
                except ValueError as exc:
                    if output_was_requested:
                        raise
                    destination.unlink(missing_ok=True)
                    source_fallback_info = native_document_info(binary, source)
                    fallback_info = native_document_info(binary, sanitized_hwpx)
                    if source_fallback_info.get("pageCount") != fallback_info.get("pageCount"):
                        raise ValueError(
                            "verified HWPX fallback pageCount changed: "
                            f"{source_fallback_info.get('pageCount')!r} -> "
                            f"{fallback_info.get('pageCount')!r}"
                        ) from exc
                    fallback = available_fallback_path(destination)
                    shutil.copy2(sanitized_hwpx, fallback)
                    fallback_conversion = {
                        "engine": str(binary),
                        "native_hwp_attempted": True,
                        "fallback_reason": str(exc),
                        "fallback_verification": report["verification"],
                    }
                    if intermediate_export is not None:
                        fallback_conversion["intermediate_export"] = intermediate_export
                    report.update(
                        {
                            "source": str(source),
                            "output": str(fallback),
                            "input_format": source_format.lstrip("."),
                            "output_format": "hwpx",
                            "conversion": fallback_conversion,
                        }
                    )
                    return report
            else:
                source_info = native_document_info(binary, source)
                output_info = native_document_info(binary, destination)
                source_page_count = source_info.get("pageCount")
                output_page_count = output_info.get("pageCount")
                if (
                    isinstance(source_page_count, int)
                    and isinstance(output_page_count, int)
                    and output_page_count < source_page_count
                ):
                    flow_preserved_hwpx = temporary / "layout-flow-preserved.hwpx"
                    report = sanitize_hwpx(
                        source_hwpx,
                        flow_preserved_hwpx,
                        title,
                        keep_media,
                        preserve_flow=True,
                    )
                    destination.unlink(missing_ok=True)
                    shutil.copy2(flow_preserved_hwpx, destination)
                    sanitized_hwpx = destination
                    output_info = native_document_info(binary, destination)
                    output_page_count = output_info.get("pageCount")
                if (
                    isinstance(source_page_count, int)
                    and isinstance(output_page_count, int)
                    and output_page_count < source_page_count
                ):
                    page_hints = temporary / "layout-with-page-breaks.hwpx"
                    added = add_page_break_hints(
                        sanitized_hwpx,
                        page_hints,
                        source_page_count - output_page_count,
                        title,
                        report["verification"]["layout"],
                    )
                    report["changes"]["inferred_page_breaks"] = added
                    destination.unlink(missing_ok=True)
                    shutil.copy2(page_hints, destination)
                    sanitized_hwpx = destination
                    output_info = native_document_info(binary, destination)
                if source_info.get("pageCount") != output_info.get("pageCount"):
                    raise ValueError(
                        "final HWPX pageCount changed: "
                        f"{source_info.get('pageCount')!r} -> {output_info.get('pageCount')!r}"
                    )
                native_verification = {
                    "format": output_info.get("format"),
                    "page_count": output_info.get("pageCount"),
                    "sections": output_info.get("sections"),
                }

            conversion = {
                "engine": str(binary),
                "native_verification": native_verification,
            }
            if intermediate_export is not None:
                conversion["intermediate_export"] = intermediate_export
            report.update(
                {
                    "source": str(source),
                    "output": str(destination),
                    "input_format": source_format.lstrip("."),
                    "output_format": output_format.lstrip("."),
                    "conversion": conversion,
                }
            )
            return report
    except Exception:
        destination.unlink(missing_ok=True)
        raise


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path, help="source .hwp or .hwpx document")
    parser.add_argument("-o", "--output", type=Path, help="explicit output .hwp or .hwpx path")
    parser.add_argument(
        "--rhwp-bin",
        type=Path,
        help="Rauhwpx CLI path for HWP input/output (otherwise RHWP_BIN, PATH, or repo build)",
    )
    parser.add_argument(
        "--keep-media",
        action="append",
        default=[],
        metavar="ID",
        help="keep a body media payload by manifest id after visual review; repeat as needed",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    try:
        report = copy_layout(args.source, args.output, set(args.keep_media), args.rhwp_bin)
    except (FileExistsError, OSError, ValueError, zipfile.BadZipFile) as exc:
        print(f"copy-layout: {exc}", file=sys.stderr)
        return 1
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
