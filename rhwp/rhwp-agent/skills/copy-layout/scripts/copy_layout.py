#!/usr/bin/env python3
"""Create a content-free HWPX while preserving its layout-bearing structure."""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
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


def sanitize_document_tree(
    tree: etree._ElementTree,
    part: str,
    removable_media: set[str],
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
            element.text = None
            for child in list(element):
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
    candidate = requested if requested else source.parent / "layout" / f"{title}.hwpx"
    candidate = candidate.expanduser().resolve()
    if candidate.suffix.lower() != ".hwpx":
        raise ValueError("output path must end in .hwpx")
    if candidate == source.resolve():
        raise ValueError("refusing to overwrite the source document")
    if candidate.exists():
        if requested:
            raise FileExistsError(f"output already exists: {candidate}")
        index = 2
        while candidate.exists():
            candidate = source.parent / "layout" / f"{title} ({index}).hwpx"
            index += 1
        candidate = candidate.resolve()
    return candidate, title


def cleaned_geometry_xml(element: etree._Element) -> bytes:
    clone = deepcopy(element)
    for node in list(clone.iter()):
        tag = local_name(node.tag)
        if tag in TEXT_ELEMENTS or tag == "script":
            node.text = None
            for child in list(node):
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
    expected_title: str,
    source_fingerprint: dict[str, object],
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
        if any(name.startswith(PAYLOAD_PREFIXES) for name in names):
            raise ValueError("preview, script, annotation, history, or chart payload remains")

        content_tree = trees.get("Contents/content.hpf")
        if content_tree is None:
            raise ValueError("Contents/content.hpf is missing")
        titles = content_tree.xpath("//*[local-name()='metadata']/*[local-name()='title']/text()")
        if titles != [expected_title]:
            raise ValueError(f"document title mismatch: {titles!r}")

        output_fingerprint = layout_fingerprint(trees)
        if output_fingerprint != source_fingerprint:
            raise ValueError("layout geometry fingerprint changed")
        return {
            "zip_valid": True,
            "xml_valid": True,
            "visible_text_nodes": 0,
            "title": expected_title,
            "layout_fingerprint_match": True,
            "layout": output_fingerprint,
        }


def copy_layout(source: Path, output: Path | None, keep_media: set[str]) -> dict[str, object]:
    source = source.expanduser().resolve()
    if not source.is_file() or source.suffix.lower() != ".hwpx":
        raise ValueError(f"source is not an HWPX file: {source}")
    destination, title = output_path_for(source, output)

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
            totals.update(sanitize_document_tree(tree, part, removable_media))
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
        "verification": verification,
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path, help="source .hwpx document")
    parser.add_argument("-o", "--output", type=Path, help="explicit output .hwpx path")
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
        report = copy_layout(args.source, args.output, set(args.keep_media))
    except (FileExistsError, OSError, ValueError, zipfile.BadZipFile) as exc:
        print(f"copy-layout: {exc}", file=sys.stderr)
        return 1
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
