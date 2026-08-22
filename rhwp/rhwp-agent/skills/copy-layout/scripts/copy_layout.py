#!/usr/bin/env python3
"""Create a reusable HWP or HWPX with reviewed template structure and content."""

from __future__ import annotations

import argparse
import hashlib
import io
import json
import os
import re
import shutil
import struct
import subprocess
import sys
import tempfile
import unicodedata
import zipfile
import zlib
import xml.etree.ElementTree as etree
from collections import Counter
from collections.abc import Sequence
from copy import deepcopy
from pathlib import Path, PurePosixPath


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
FORM_CONTROL_ELEMENTS = {
    "button",
    "checkBtn",
    "comboBox",
    "edit",
    "listBox",
    "radioBtn",
}
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
PUBLISHABLE_PREVIEW_TEXT = b""


def png_chunk(kind: bytes, data: bytes) -> bytes:
    payload = kind + data
    return (
        struct.pack(">I", len(data))
        + payload
        + struct.pack(">I", zlib.crc32(payload) & 0xFFFFFFFF)
    )


PUBLISHABLE_PREVIEW_IMAGE = (
    b"\x89PNG\r\n\x1a\n"
    + png_chunk(b"IHDR", struct.pack(">IIBBBBB", 1, 1, 8, 6, 0, 0, 0))
    + png_chunk(b"IDAT", zlib.compress(b"\x00\xff\xff\xff\xff"))
    + png_chunk(b"IEND", b"")
)
PUBLISHABLE_PREVIEW_ENTRIES = {
    "Preview/PrvText.txt": PUBLISHABLE_PREVIEW_TEXT,
    "Preview/PrvImage.png": PUBLISHABLE_PREVIEW_IMAGE,
}
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
GUIDANCE_HEADINGS = {
    "개요",
    "결과",
    "결론",
    "기대 효과",
    "기획 의도",
    "내용",
    "답안",
    "방법",
    "배경",
    "역할 분담",
    "일정",
    "작품 개요",
    "작품 설명",
    "주제",
    "참고 문헌",
    "참고 자료",
    "팀 구성",
    "목적",
    "과제 개요",
    "과제 내용",
    "과제 목적",
    "과제 목표",
    "과제명",
    "답안 작성",
    "답안란",
    "분량",
    "심사 기준",
    "안내 사항",
    "유의 사항",
    "응모 자격",
    "응모 부문",
    "작품 규격",
    "작성 안내",
    "작성 요령",
    "작성란",
    "제출 기한",
    "제출 방법",
    "제출 안내",
    "제출 요건",
    "제출물",
    "제출 형식",
    "주의 사항",
    "지시 사항",
    "참가 자격",
    "평가 기준",
    "answer",
    "assignment",
    "background",
    "conclusion",
    "deadline",
    "deliverables",
    "eligibility",
    "evaluation criteria",
    "guidelines",
    "instructions",
    "judging criteria",
    "method",
    "methodology",
    "notes",
    "objective",
    "objectives",
    "overview",
    "project description",
    "purpose",
    "rationale",
    "references",
    "results",
    "requirements",
    "response",
    "rules",
    "submission format",
    "submission instructions",
    "topic",
}
GUIDANCE_PREFIXES = {
    "분량",
    "심사 기준",
    "응모 자격",
    "응모 부문",
    "작품 규격",
    "제출 기한",
    "제출 방법",
    "제출 요건",
    "제출 형식",
    "참가 자격",
    "평가 기준",
    "deadline",
    "deliverables",
    "eligibility",
    "evaluation criteria",
    "judging criteria",
    "requirements",
    "submission format",
}
KOREAN_INSTRUCTION_RE = re.compile(
    r"(?:작성|기재|제출|첨부|선택|표시|설명|기술|서술|응답|답변|준수|포함|제외|확인)"
    r".{0,100}(?:하세요|하십시오|하시오|바랍니다|해야\s*합니다|하여야\s*합니다|할\s*것|해\s*주세요)"
    r"|(?:고르시오|쓰시오|답하시오|설명하시오|기술하시오|서술하시오)"
)
ENGLISH_INSTRUCTION_RE = re.compile(
    r"^(?:please\s+)?(?:submit|include|attach|select|choose|write|describe|explain|answer|provide|follow)\b"
    r"|^(?:do\s+not|don't)\b|\b(?:must|required\s+to|should)\b",
    re.IGNORECASE,
)
NUMBERED_STRUCTURE_HEADING_RE = re.compile(
    r"^(?:문제|문항|과제|question|task)\s*\d+\s*[.)]?\s*$",
    re.IGNORECASE,
)
GUIDANCE_IDENTIFIER_RE = re.compile(
    r"https?://|www\.\S+|\b[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}\b|\b0\d{1,2}-\d{3,4}-\d{4}\b",
    re.IGNORECASE,
)
ILLEGAL_XML_CONTROL_RE = re.compile(br"[\x00-\x08\x0B\x0C\x0E-\x1F]")
# WORD JOINER has zero visual width but is not Unicode whitespace. Keeping one
# in a text fragment whose private payload was removed preserves HWPX layout
# semantics that distinguish a real text host from an intrinsically empty
# floating-object anchor, without retaining source content or widening cells.
LAYOUT_ANCHOR = "\u2060"


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


def layout_anchor_text(value: str | None) -> str | None:
    if value is None:
        return None
    return LAYOUT_ANCHOR if normalize_visible_text(value) else value


def normalize_visible_text(value: str) -> str:
    return re.sub(r"\s+", " ", value.replace(LAYOUT_ANCHOR, "")).strip()


def guidance_heading_candidate(value: str) -> str:
    candidate = re.sub(
        r"^\s*(?:(?:\d+|[A-Za-z]|[가-힣])\s*[.)]|[①-⑳])\s*",
        "",
        value,
    )
    return candidate.strip(" \t\r\n:：-–—_·.…[]()<>〈〉《》【】")


def is_guidance_paragraph(value: str) -> bool:
    """Recognize only conservative template headings and imperative guidance."""
    normalized = normalize_visible_text(value)
    if not normalized or len(normalized) > 600:
        return False
    if GUIDANCE_IDENTIFIER_RE.search(normalized):
        return False
    candidate = guidance_heading_candidate(normalized).casefold()
    if candidate in GUIDANCE_HEADINGS:
        return True
    if NUMBERED_STRUCTURE_HEADING_RE.fullmatch(candidate):
        return True
    for prefix in GUIDANCE_PREFIXES:
        if candidate.startswith(f"{prefix}: ") or candidate.startswith(f"{prefix}："):
            return True
    return bool(
        KOREAN_INSTRUCTION_RE.search(normalized)
        or ENGLISH_INSTRUCTION_RE.search(normalized)
    )


def parse_xml(data: bytes, part: str) -> etree.ElementTree:
    if re.search(br"<!DOCTYPE|<!ENTITY", data, flags=re.IGNORECASE):
        raise ValueError(f"unsafe XML declaration in {part}")
    # Some Hangul-generated packages contain stray XML 1.0 control bytes
    # between elements. They have no visible or structural meaning, and
    # dropping them lets otherwise valid packages be inspected and sanitized.
    data = ILLEGAL_XML_CONTROL_RE.sub(b"", data)
    try:
        for _, namespace in etree.iterparse(io.BytesIO(data), events=("start-ns",)):
            prefix, uri = namespace
            # ElementTree reserves ns0, ns1, ... for prefixes it generates.
            # Those prefixes are legal in source HWPX packages, so let the
            # serializer assign an equivalent prefix instead of rejecting XML.
            if prefix != "xml" and not re.fullmatch(r"ns\d+", prefix or ""):
                etree.register_namespace(prefix or "", uri)
        return etree.ElementTree(etree.fromstring(data))
    except (etree.ParseError, ValueError) as exc:
        raise ValueError(f"invalid XML in {part}: {exc}") from exc


def serialize_xml(tree: etree.ElementTree, original: bytes) -> bytes:
    standalone = b' standalone="yes"' if re.search(
        br"standalone\s*=\s*['\"]yes['\"]",
        original[:256],
    ) else b""
    declaration = b'<?xml version="1.0" encoding="UTF-8"' + standalone + b"?>\n"
    return declaration + etree.tostring(tree.getroot(), encoding="utf-8")


def parent_map(root: etree.Element) -> dict[etree.Element, etree.Element]:
    return {child: parent for parent in root.iter() for child in parent}


def descendants_named(root: etree.Element, name: str) -> list[etree.Element]:
    return [element for element in root.iter() if local_name(element.tag) == name]


def children_named(root: etree.Element, name: str) -> list[etree.Element]:
    return [element for element in root if local_name(element.tag) == name]


def ancestors_of(
    element: etree.Element,
    parents: dict[etree.Element, etree.Element],
):
    current = parents.get(element)
    while current is not None:
        yield current
        current = parents.get(current)


def file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def paragraph_text_nodes(
    paragraph: etree.Element,
    parents: dict[etree.Element, etree.Element],
) -> list[etree.Element]:
    """Return text owned by this paragraph, excluding nested table paragraphs."""
    return [
        element
        for element in paragraph.iter()
        if local_name(element.tag) == "t"
        and next(
            (
                ancestor
                for ancestor in ancestors_of(element, parents)
                if local_name(ancestor.tag) == "p"
            ),
            None,
        )
        is paragraph
    ]


def nearest_ancestor_named(
    element: etree.Element,
    parents: dict[etree.Element, etree.Element],
    names: set[str],
) -> etree.Element | None:
    return next(
        (
            ancestor
            for ancestor in ancestors_of(element, parents)
            if local_name(ancestor.tag) in names
        ),
        None,
    )


def paragraph_record(
    paragraph: etree.Element,
    part: str,
    index: int,
    parents: dict[etree.Element, etree.Element],
) -> tuple[dict[str, object], list[etree.Element]] | None:
    text_nodes = paragraph_text_nodes(paragraph, parents)
    text = normalize_visible_text(
        "".join("".join(element.itertext()) for element in text_nodes)
    )
    if not text:
        return None

    paragraph_id = f"{part}#p{index:04d}"
    cell = nearest_ancestor_named(paragraph, parents, {"tc"})
    cell_address = None
    if cell is not None:
        address = next(
            (child for child in cell if local_name(child.tag) == "cellAddr"),
            None,
        )
        if address is not None:
            cell_address = {
                key: address.get(key)
                for key in ("colAddr", "rowAddr")
                if address.get(key) is not None
            }

    ancestor_names = {local_name(ancestor.tag) for ancestor in ancestors_of(paragraph, parents)}
    path = PurePosixPath(part)
    in_header_footer = bool(
        ancestor_names & {"header", "footer", "masterPage"}
        or part == "Contents/header.xml"
        or (path.parent == PurePosixPath("Contents") and path.name.startswith("masterpage"))
    )
    field_markers = sum(
        1 for element in paragraph.iter() if local_name(element.tag) in FIELD_ELEMENTS
    )
    record: dict[str, object] = {
        "id": paragraph_id,
        "part": part,
        "paragraph_index": index,
        "text": text,
        "context": {
            "in_table": cell is not None,
            "cell_address": cell_address,
            "in_header_footer": in_header_footer,
            "in_shape": bool(ancestor_names & (OBJECT_ELEMENTS - {"tbl"})),
            "field_markers": field_markers,
            "para_pr_id": paragraph.get("paraPrIDRef"),
            "style_id": paragraph.get("styleIDRef"),
            "legacy_guidance_match": is_guidance_paragraph(text),
        },
    }
    return record, text_nodes


def text_inventory_from_trees(
    trees: dict[str, etree.ElementTree],
) -> list[dict[str, object]]:
    records: list[dict[str, object]] = []
    for part in sorted(trees):
        if not is_document_xml(part):
            continue
        root = trees[part].getroot()
        parents = parent_map(root)
        paragraphs = [element for element in root.iter() if local_name(element.tag) == "p"]
        for index, paragraph in enumerate(paragraphs):
            result = paragraph_record(paragraph, part, index, parents)
            if result is not None:
                records.append(result[0])
    return records


def field_inventory_from_trees(
    trees: dict[str, etree.ElementTree],
) -> list[dict[str, object]]:
    fields: list[dict[str, object]] = []
    for part in sorted(trees):
        if not is_document_xml(part):
            continue
        index = 0
        for element in trees[part].iter():
            if local_name(element.tag) != "fieldBegin":
                continue
            fields.append(
                {
                    "id": f"{part}#field{index:04d}",
                    "part": part,
                    "type": element.get("type"),
                    "name": element.get("name"),
                    "editable": element.get("editable"),
                }
            )
            index += 1
    return fields


def form_control_inventory_from_trees(
    trees: dict[str, etree.ElementTree],
) -> list[dict[str, object]]:
    controls: list[dict[str, object]] = []
    for part in sorted(trees):
        if not is_document_xml(part):
            continue
        root = trees[part].getroot()
        parents = parent_map(root)
        paragraphs = [element for element in root.iter() if local_name(element.tag) == "p"]
        paragraph_indexes = {paragraph: index for index, paragraph in enumerate(paragraphs)}
        index = 0
        for element in root.iter():
            tag = local_name(element.tag)
            if tag not in FORM_CONTROL_ELEMENTS:
                continue
            paragraph = nearest_ancestor_named(element, parents, {"p"})
            paragraph_id = (
                f"{part}#p{paragraph_indexes[paragraph]:04d}"
                if paragraph in paragraph_indexes
                else None
            )
            controls.append(
                {
                    "id": f"{part}#control{index:04d}",
                    "part": part,
                    "kind": tag,
                    "paragraph_id": paragraph_id,
                    "name": element.get("name"),
                    "caption": element.get("caption"),
                    "value": element.get("value"),
                    "editable": element.get("editable"),
                    "enabled": element.get("enabled"),
                }
            )
            index += 1
    return controls


def named_attribute_inventory_from_trees(
    trees: dict[str, etree.ElementTree],
) -> list[dict[str, str]]:
    named: list[dict[str, str]] = []
    for part in sorted(trees):
        if not is_document_xml(part):
            continue
        for index, element in enumerate(trees[part].iter()):
            value = next(
                (
                    attr_value
                    for attr_name, attr_value in element.attrib.items()
                    if local_name(attr_name) == "name" and attr_value
                ),
                None,
            )
            if value is None:
                continue
            named.append(
                {
                    "id": f"{part}#element{index:04d}",
                    "part": part,
                    "element": local_name(element.tag),
                    "name": value,
                }
            )
    return named


def reset_form_controls(
    trees: dict[str, etree.ElementTree],
    selected_ids: set[str],
) -> list[dict[str, object]]:
    if not selected_ids:
        return []
    available: dict[str, etree.Element] = {}
    for part in sorted(trees):
        if not is_document_xml(part):
            continue
        index = 0
        for element in trees[part].iter():
            if local_name(element.tag) not in FORM_CONTROL_ELEMENTS:
                continue
            available[f"{part}#control{index:04d}"] = element
            index += 1
    unknown = selected_ids - set(available)
    if unknown:
        raise ValueError(
            "text decision plan contains unknown form-control ids: "
            + ", ".join(sorted(unknown)[:5])
        )

    reset: list[dict[str, object]] = []
    for control_id in sorted(selected_ids):
        element = available[control_id]
        tag = local_name(element.tag)
        before = {
            "id": control_id,
            "kind": tag,
            "name": element.get("name"),
            "caption": element.get("caption"),
            "value": element.get("value"),
        }
        if tag in {"checkBtn", "radioBtn"}:
            element.set("value", "UNCHECKED")
        else:
            for attr_name in ("text", "value"):
                if element.get(attr_name) is not None:
                    element.set(attr_name, "")
        reset.append(before)
    return reset


def border_fill_mark_inventory(
    trees: dict[str, etree.ElementTree],
) -> list[dict[str, object]]:
    marks: list[dict[str, object]] = []
    uses: dict[str, list[dict[str, object]]] = {}
    for part, tree in trees.items():
        if not is_document_xml(part):
            continue
        for element in tree.iter():
            border_fill_id = element.get("borderFillIDRef")
            if not border_fill_id:
                continue
            use: dict[str, object] = {"part": part, "element": local_name(element.tag)}
            if local_name(element.tag) == "tc":
                address = next(
                    (child for child in element if local_name(child.tag) == "cellAddr"),
                    None,
                )
                if address is not None:
                    use["cell_address"] = {
                        key: address.get(key)
                        for key in ("colAddr", "rowAddr")
                        if address.get(key) is not None
                    }
                use["has_text"] = any(
                    normalize_visible_text("".join(text.itertext()))
                    for text in element.iter()
                    if local_name(text.tag) == "t"
                )
            uses.setdefault(border_fill_id, []).append(use)

    for part, tree in trees.items():
        for border_fill in tree.iter():
            if local_name(border_fill.tag) != "borderFill":
                continue
            border_fill_id = border_fill.get("id")
            diagonal = next(
                (child for child in border_fill if local_name(child.tag) == "diagonal"),
                None,
            )
            slash = next(
                (child for child in border_fill if local_name(child.tag) == "slash"),
                None,
            )
            win_brush = next(
                (
                    descendant
                    for descendant in border_fill.iter()
                    if local_name(descendant.tag) == "winBrush"
                ),
                None,
            )
            if not border_fill_id or diagonal is None:
                continue
            width_match = re.search(r"[0-9.]+", diagonal.get("width", ""))
            width = float(width_match.group()) if width_match else 0.0
            color = diagonal.get("color", "#000000").upper()
            crooked = slash is not None and slash.get("Crooked") == "1"
            border_uses = uses.get(border_fill_id, [])
            if width > 0.5 or color not in {"#000000", "#000", "BLACK", "NONE"} or crooked:
                marks.append(
                    {
                        "id": border_fill_id,
                        "part": part,
                        "kind": "diagonal-border-mark",
                        "width": diagonal.get("width"),
                        "color": diagonal.get("color"),
                        "center_line": border_fill.get("centerLine"),
                        "crooked": crooked,
                        "uses": border_uses,
                    }
                )
            face_color = (
                win_brush.get("faceColor", "#FFFFFF").upper()
                if win_brush is not None
                else "#FFFFFF"
            )
            empty_cell_uses = [
                use
                for use in border_uses
                if use.get("element") == "tc" and not use.get("has_text")
            ]
            if (
                win_brush is not None
                and face_color not in {"#FFFFFF", "#FFF", "WHITE", "NONE"}
                and empty_cell_uses
                and len(empty_cell_uses) == len(border_uses)
            ):
                marks.append(
                    {
                        "id": border_fill_id,
                        "part": part,
                        "kind": "empty-cell-fill-mark",
                        "face_color": win_brush.get("faceColor"),
                        "hatch_color": win_brush.get("hatchColor"),
                        "alpha": win_brush.get("alpha"),
                        "uses": border_uses,
                    }
                )
    return marks


def clear_border_fill_marks(
    trees: dict[str, etree.ElementTree],
    selected_ids: set[str],
) -> list[dict[str, object]]:
    if not selected_ids:
        return []
    available: dict[str, etree.Element] = {}
    for tree in trees.values():
        for element in tree.iter():
            if local_name(element.tag) == "borderFill" and element.get("id"):
                available[element.get("id", "")] = element
    unknown = selected_ids - set(available)
    if unknown:
        raise ValueError(
            "text decision plan contains unknown border-fill ids: "
            + ", ".join(sorted(unknown)[:5])
        )

    cleared: list[dict[str, object]] = []
    for border_fill_id in sorted(selected_ids):
        border_fill = available[border_fill_id]
        before: dict[str, object] = {"id": border_fill_id}
        diagonal = next(
            (child for child in border_fill if local_name(child.tag) == "diagonal"),
            None,
        )
        slash = next(
            (child for child in border_fill if local_name(child.tag) == "slash"),
            None,
        )
        width_match = (
            re.search(r"[0-9.]+", diagonal.get("width", ""))
            if diagonal is not None
            else None
        )
        width = float(width_match.group()) if width_match else 0.0
        color = diagonal.get("color", "#000000").upper() if diagonal is not None else "#000000"
        diagonal_is_mark = bool(
            diagonal is not None
            and (
                width > 0.5
                or color not in {"#000000", "#000", "BLACK", "NONE"}
                or (slash is not None and slash.get("Crooked") == "1")
            )
        )
        if diagonal_is_mark:
            border_fill.set("centerLine", "NONE")
        for child in border_fill:
            tag = local_name(child.tag)
            if diagonal_is_mark and tag in {"slash", "backSlash"}:
                before[tag] = dict(child.attrib)
                child.set("type", "NONE")
                child.set("Crooked", "0")
                child.set("isCounter", "0")
            elif diagonal_is_mark and tag == "diagonal":
                before[tag] = dict(child.attrib)
                child.set("type", "SOLID")
                child.set("width", "0.1 mm")
                child.set("color", "#000000")
            elif tag == "fillBrush":
                for descendant in child.iter():
                    if local_name(descendant.tag) != "winBrush":
                        continue
                    before["winBrush"] = dict(descendant.attrib)
                    descendant.set("faceColor", "#FFFFFF")
                    descendant.set("hatchColor", "#FFFFFF")
                    descendant.set("alpha", "0")
        cleared.append(before)
    return cleared


def inspect_hwpx(source: Path, identity_source: Path | None = None) -> dict[str, object]:
    with zipfile.ZipFile(source) as archive:
        if archive.testzip():
            raise ValueError("source HWPX contains a corrupt ZIP entry")
        trees = {
            name: parse_xml(archive.read(name), name)
            for name in archive.namelist()
            if is_xml_part(name)
        }
    records = text_inventory_from_trees(trees)
    identity = (identity_source or source).resolve()
    return {
        "source": str(identity),
        "source_sha256": file_sha256(identity),
        "paragraph_count": len(records),
        "paragraphs": records,
        "fields": field_inventory_from_trees(trees),
        "form_controls": form_control_inventory_from_trees(trees),
        "named_attributes": named_attribute_inventory_from_trees(trees),
        "visual_marks": border_fill_mark_inventory(trees),
    }


def load_text_plan(path: Path, source: Path) -> dict[str, object]:
    try:
        payload = json.loads(path.expanduser().read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise ValueError(f"invalid text decision JSON: {exc}") from exc
    if not isinstance(payload, dict):
        raise ValueError("text decision plan must be a JSON object")
    expected_digest = payload.get("source_sha256")
    actual_digest = file_sha256(source)
    if not isinstance(expected_digest, str) or expected_digest != actual_digest:
        raise ValueError("text decision plan source_sha256 does not match the source document")
    default = payload.get("default")
    if default not in {"keep", "remove"}:
        raise ValueError("text decision plan default must be 'keep' or 'remove'")

    normalized: dict[str, object] = {
        "source_sha256": expected_digest,
        "default": default,
    }
    for action in ("keep", "remove"):
        values = payload.get(action, [])
        if not isinstance(values, list) or any(not isinstance(value, str) for value in values):
            raise ValueError(f"text decision plan {action} must be a list of paragraph ids")
        if len(values) != len(set(values)):
            raise ValueError(f"text decision plan {action} contains duplicate paragraph ids")
        normalized[action] = set(values)
    replacements = payload.get("replace", {})
    if not isinstance(replacements, dict) or any(
        not isinstance(paragraph_id, str) or not isinstance(value, str)
        for paragraph_id, value in replacements.items()
    ):
        raise ValueError("text decision plan replace must map paragraph ids to text")
    if any(not normalize_visible_text(value) for value in replacements.values()):
        raise ValueError("text decision plan replacements must contain visible text")
    normalized["replace"] = replacements
    clear_marks = payload.get("clear_border_fill_marks", [])
    if not isinstance(clear_marks, list) or any(
        not isinstance(border_fill_id, str) for border_fill_id in clear_marks
    ):
        raise ValueError("text decision plan clear_border_fill_marks must be a list of ids")
    if len(clear_marks) != len(set(clear_marks)):
        raise ValueError("text decision plan clear_border_fill_marks contains duplicate ids")
    normalized["clear_border_fill_marks"] = set(clear_marks)
    reset_controls = payload.get("reset_form_controls", [])
    if not isinstance(reset_controls, list) or any(
        not isinstance(control_id, str) for control_id in reset_controls
    ):
        raise ValueError("text decision plan reset_form_controls must be a list of ids")
    if len(reset_controls) != len(set(reset_controls)):
        raise ValueError("text decision plan reset_form_controls contains duplicate ids")
    normalized["reset_form_controls"] = set(reset_controls)
    overlap = normalized["keep"] & normalized["remove"]
    if overlap:
        raise ValueError(
            "text decision plan assigns both keep and remove: "
            + ", ".join(sorted(overlap)[:5])
        )
    replacement_removals = set(replacements) & normalized["remove"]
    if replacement_removals:
        raise ValueError(
            "text decision plan cannot replace and remove the same paragraph: "
            + ", ".join(sorted(replacement_removals)[:5])
        )
    return normalized


def validate_text_plan_ids(
    text_plan: dict[str, object],
    records: Sequence[dict[str, object]],
) -> None:
    known = {str(record["id"]) for record in records}
    explicit = (
        set(text_plan["keep"])
        | set(text_plan["remove"])
        | set(text_plan["replace"])
    )
    unknown = explicit - known
    if unknown:
        raise ValueError(
            "text decision plan contains unknown paragraph ids: "
            + ", ".join(sorted(unknown)[:5])
        )


def replace_paragraph_text(text_nodes: Sequence[etree.Element], replacement: str) -> None:
    first = True
    for element in text_nodes:
        element.text = replacement if first else None
        first = False
        for child in list(element):
            if local_name(child.tag) in TEXT_MARKUP_REMOVE:
                element.remove(child)
                continue
            child.tail = None
            for descendant in child.iter():
                descendant.text = None
                if descendant is not child:
                    descendant.tail = None


def select_planned_text_nodes(
    root: etree.Element,
    part: str,
    text_plan: dict[str, object],
) -> tuple[set[etree.Element], list[dict[str, object]], list[dict[str, object]]]:
    selected: set[etree.Element] = set()
    kept: list[dict[str, object]] = []
    removed: list[dict[str, object]] = []
    parents = parent_map(root)
    paragraphs = [element for element in root.iter() if local_name(element.tag) == "p"]
    for index, paragraph in enumerate(paragraphs):
        result = paragraph_record(paragraph, part, index, parents)
        if result is None:
            continue
        record, text_nodes = result
        paragraph_id = str(record["id"])
        action = (
            "keep"
            if paragraph_id in text_plan["keep"] or paragraph_id in text_plan["replace"]
            else "remove"
            if paragraph_id in text_plan["remove"]
            else str(text_plan["default"])
        )
        replacement = text_plan["replace"].get(paragraph_id)
        if replacement is not None:
            replace_paragraph_text(text_nodes, replacement)
        compact = {
            "id": paragraph_id,
            "part": part,
            "text": replacement if replacement is not None else record["text"],
            "explicit": (
                paragraph_id in text_plan[action]
                or paragraph_id in text_plan["replace"]
            ),
        }
        if replacement is not None:
            compact["source_text"] = record["text"]
        if action == "keep":
            selected.update(text_nodes)
            kept.append(compact)
        else:
            removed.append(compact)
    return selected, kept, removed


def select_guidance_text_nodes(
    root: etree.Element,
) -> tuple[set[etree.Element], list[str]]:
    selected: set[etree.Element] = set()
    paragraphs: list[str] = []
    parents = parent_map(root)
    for paragraph in root.iter():
        if local_name(paragraph.tag) != "p":
            continue
        text_nodes = paragraph_text_nodes(paragraph, parents)
        text = normalize_visible_text(
            "".join("".join(element.itertext()) for element in text_nodes)
        )
        if text and is_guidance_paragraph(text):
            selected.update(text_nodes)
            paragraphs.append(text)
    return selected, paragraphs


def visible_text_fragments(
    trees: dict[str, etree.ElementTree],
) -> list[tuple[str, str]]:
    fragments: list[tuple[str, str]] = []
    for part in sorted(trees):
        if not is_document_xml(part):
            continue
        for element in trees[part].iter():
            if local_name(element.tag) not in TEXT_ELEMENTS:
                continue
            text = normalize_visible_text("".join(element.itertext()))
            if text:
                fragments.append((part, text))
    return fragments


def remove_child_preserving_tail(parent: etree.Element, child: etree.Element) -> None:
    siblings = list(parent)
    index = siblings.index(child)
    if child.tail:
        if index == 0:
            parent.text = (parent.text or "") + child.tail
        else:
            previous = siblings[index - 1]
            previous.tail = (previous.tail or "") + child.tail
    parent.remove(child)


def is_xml_part(name: str) -> bool:
    return PurePosixPath(name).suffix.lower() in {".xml", ".hpf", ".rdf"}


def is_document_xml(name: str) -> bool:
    path = PurePosixPath(name)
    return (
        name == "Contents/header.xml"
        or (path.parent == PurePosixPath("Contents") and path.name.startswith("section"))
        or (path.parent == PurePosixPath("Contents") and path.name.startswith("masterpage"))
    )


def manifest_map(tree: etree.ElementTree) -> dict[str, str]:
    result: dict[str, str] = {}
    for manifest in descendants_named(tree.getroot(), "manifest"):
        for item in children_named(manifest, "item"):
            item_id = item.get("id")
            href = item.get("href")
            if item_id and href:
                result[item_id] = href.lstrip("/")
    return result


def element_is_layout_media(
    element: etree.Element,
    part: str,
    parents: dict[etree.Element, etree.Element],
) -> bool:
    path = PurePosixPath(part)
    if path.parent == PurePosixPath("Contents") and path.name.startswith("masterpage"):
        return True
    if part == "Contents/header.xml":
        return True
    current: etree.Element | None = element
    while current is not None:
        if local_name(current.tag) in LAYOUT_ANCESTORS:
            return True
        current = parents.get(current)
    return False


def collect_media_uses(
    trees: dict[str, etree.ElementTree],
) -> tuple[dict[str, list[str]], dict[str, list[str]]]:
    layout: dict[str, list[str]] = {}
    body: dict[str, list[str]] = {}
    for part, tree in trees.items():
        if not is_document_xml(part):
            continue
        parents = parent_map(tree.getroot())
        for element in tree.iter():
            for attr_name, value in element.attrib.items():
                if local_name(attr_name) != "binaryItemIDRef" or not value:
                    continue
                bucket = layout if element_is_layout_media(element, part, parents) else body
                bucket.setdefault(value, []).append(f"{part}:{local_name(element.tag)}")
    return layout, body


def remove_field_markers(root: etree.Element) -> int:
    removed = 0
    parents = parent_map(root)
    for element in list(root.iter()):
        if local_name(element.tag) not in FIELD_ELEMENTS:
            continue
        parent = parents.get(element)
        if parent is not None:
            parent.remove(element)
            removed += 1
    return removed


def infer_rendered_page_breaks(root: etree.Element, limit: int) -> int:
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
    tree: etree.ElementTree,
    part: str,
    removable_media: set[str],
    preserve_flow: bool,
    preserve_guidance: bool,
    text_plan: dict[str, object] | None = None,
) -> tuple[
    dict[str, int],
    list[str],
    list[tuple[str, str]],
    list[dict[str, object]],
    list[dict[str, object]],
]:
    stats = Counter()
    root = tree.getroot()
    kept_paragraphs: list[dict[str, object]] = []
    removed_paragraphs: list[dict[str, object]] = []
    if text_plan is not None:
        approved_nodes, kept_paragraphs, removed_paragraphs = select_planned_text_nodes(
            root,
            part,
            text_plan,
        )
        guidance_paragraphs: list[str] = []
    else:
        approved_nodes, guidance_paragraphs = (
            select_guidance_text_nodes(root) if preserve_guidance else (set(), [])
        )
    if text_plan is None:
        stats["field_markers_removed"] += remove_field_markers(root)
    else:
        stats["field_markers_preserved"] += sum(
            1 for element in root.iter() if local_name(element.tag) in FIELD_ELEMENTS
        )
    parents = parent_map(root)

    # Snapshot first: clearing inline children while walking a live iterator
    # can skip later sibling runs in long paragraphs.
    for element in list(root.iter()):
        tag = local_name(element.tag)
        if tag in TEXT_ELEMENTS:
            if tag == "t" and element in approved_nodes:
                stats["approved_text_nodes_preserved"] += 1
                for child in list(element):
                    if local_name(child.tag) in TEXT_MARKUP_REMOVE:
                        remove_child_preserving_tail(element, child)
            else:
                if element.text or len(element):
                    stats["text_nodes_cleared"] += 1
                element.text = (
                    blank_text(element.text)
                    if tag == "t" and preserve_flow
                    else layout_anchor_text(element.text)
                    if tag == "t"
                    else None
                )
                for child in list(element):
                    child.tail = (
                        blank_text(child.tail)
                        if tag == "t" and preserve_flow
                        else layout_anchor_text(child.tail)
                        if tag == "t"
                        else None
                    )
                    if tag == "shapeComment" or local_name(child.tag) in TEXT_MARKUP_REMOVE:
                        element.remove(child)
        elif tag == "script" and any(
            local_name(ancestor.tag) == "equation"
            for ancestor in ancestors_of(element, parents)
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
            elif (
                attr in PRIVATE_ATTRS
                and value
                and not (
                    text_plan is not None
                    and attr == "name"
                )
            ):
                element.set(attr_name, "")
                stats["private_attributes_cleared"] += 1
            elif (
                text_plan is None
                and tag in {"formObject", "fieldBegin"}
                and attr in {"caption", "text", "value"}
                and value
            ):
                element.set(attr_name, "")
                stats["form_values_cleared"] += 1
    approved_fragments = [
        (part, text)
        for element in root.iter()
        if element in approved_nodes
        if (text := normalize_visible_text("".join(element.itertext())))
    ]
    return (
        dict(stats),
        guidance_paragraphs,
        approved_fragments,
        kept_paragraphs,
        removed_paragraphs,
    )


def sanitize_metadata(tree: etree.ElementTree, title: str) -> dict[str, int]:
    stats = Counter()
    metadata_nodes = descendants_named(tree.getroot(), "metadata")
    for metadata in metadata_nodes:
        title_nodes = children_named(metadata, "title")
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
    tree: etree.ElementTree,
    removed_parts: set[str],
) -> int:
    removed_ids: set[str] = set()
    removed = 0
    for manifest in descendants_named(tree.getroot(), "manifest"):
        for item in list(children_named(manifest, "item")):
            href = (item.get("href") or "").lstrip("/")
            if href not in removed_parts:
                continue
            item_id = item.get("id")
            if item_id:
                removed_ids.add(item_id)
            manifest.remove(item)
            removed += 1
    for spine in descendants_named(tree.getroot(), "spine"):
        for itemref in list(children_named(spine, "itemref")):
            if itemref.get("idref") in removed_ids:
                spine.remove(itemref)
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


def set_delivery(
    report: dict[str, object],
    warnings: Sequence[str] = (),
) -> dict[str, object]:
    """Mark a safety-verified output as deliverable and qualify fidelity separately."""
    delivery_warnings = list(dict.fromkeys(warning for warning in warnings if warning))
    report["delivery"] = {
        "ready": True,
        "quality": "best_effort" if delivery_warnings else "verified",
        "warnings": delivery_warnings,
    }
    return report


def deliver_hwpx_fallback(
    destination: Path,
    sanitized_hwpx: Path,
    report: dict[str, object],
    source: Path,
    source_format: str,
    binary: Path,
    reason: Exception,
    intermediate_export: dict[str, object] | None,
) -> dict[str, object]:
    """Deliver the validated HWPX when native HWP fidelity checks fail."""
    destination.unlink(missing_ok=True)
    warnings = [f"native HWP fidelity verification failed: {reason}"]
    try:
        source_pages = native_document_info(binary, source).get("pageCount")
        fallback_pages = native_document_info(binary, sanitized_hwpx).get("pageCount")
    except (OSError, ValueError) as exc:
        source_pages = None
        fallback_pages = None
        warnings.append(f"fallback page-count comparison was unavailable: {exc}")
    else:
        if source_pages != fallback_pages:
            warnings.append(
                f"fallback HWPX pageCount changed: {source_pages!r} -> {fallback_pages!r}"
            )

    fallback = available_fallback_path(destination)
    shutil.copy2(sanitized_hwpx, fallback)
    fallback_conversion: dict[str, object] = {
        "engine": str(binary),
        "native_hwp_attempted": True,
        "fallback_reason": str(reason),
        "fallback_page_count": {
            "source": source_pages,
            "output": fallback_pages,
        },
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
    return set_delivery(report, warnings)


def cleaned_geometry_xml(element: etree.Element) -> bytes:
    clone = deepcopy(element)
    parents = parent_map(clone)
    for node in list(clone.iter()):
        tag = local_name(node.tag)
        if tag in FIELD_ELEMENTS:
            parent = parents.get(node)
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
    return etree.tostring(clone, encoding="utf-8")


def layout_fingerprint(trees: dict[str, etree.ElementTree]) -> dict[str, object]:
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
            for name in sorted(set(entries) - set(info_by_name)):
                archive.writestr(name, entries[name], compress_type=zipfile.ZIP_DEFLATED)
    except Exception:
        output.unlink(missing_ok=True)
        raise


def validate_output(
    output: Path,
    expected_title: str | None,
    source_fingerprint: dict[str, object],
    allow_generated_preview: bool = False,
    require_geometry_hash: bool = True,
    expected_visible_text: Sequence[tuple[str, str]] | None = (),
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

        trees: dict[str, etree.ElementTree] = {}
        for name in names:
            if is_xml_part(name):
                trees[name] = parse_xml(archive.read(name), name)
            if is_document_xml(name):
                if name not in trees:
                    raise ValueError(f"document part is not XML: {name}")

        actual_visible_text = visible_text_fragments(trees)
        if expected_visible_text is not None and Counter(actual_visible_text) != Counter(
            expected_visible_text
        ):
            locations = ", ".join(part for part, _ in actual_visible_text[:5])
            if not expected_visible_text:
                raise ValueError(f"visible text remains: {locations}")
            raise ValueError("visible text differs from approved guidance")
        forbidden_prefixes = tuple(prefix for prefix in PAYLOAD_PREFIXES if prefix != "Preview/")
        if any(name.startswith(forbidden_prefixes) for name in names):
            raise ValueError("script, annotation, history, or chart payload remains")
        if not allow_generated_preview:
            preview_names = {name for name in names if name.startswith("Preview/")}
            if preview_names != set(PUBLISHABLE_PREVIEW_ENTRIES):
                raise ValueError("publishable HWPX preview entries are missing or unexpected")
            for name, expected in PUBLISHABLE_PREVIEW_ENTRIES.items():
                if archive.read(name) != expected:
                    raise ValueError(f"privacy-safe HWPX preview differs: {name}")

        content_tree = trees.get("Contents/content.hpf")
        if content_tree is None:
            raise ValueError("Contents/content.hpf is missing")
        titles = [
            title_node.text or ""
            for metadata in descendants_named(content_tree.getroot(), "metadata")
            for title_node in children_named(metadata, "title")
        ]
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
            "visible_text_nodes": len(actual_visible_text),
            "approved_visible_text": [
                {"part": part, "text": text}
                for part, text in actual_visible_text
            ],
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
    preserve_flow: bool = False,
    preserve_guidance: bool = False,
    text_plan: dict[str, object] | None = None,
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
    source_fields = field_inventory_from_trees(trees)
    source_controls = form_control_inventory_from_trees(trees)
    source_named_attributes = named_attribute_inventory_from_trees(trees)
    inventory = text_inventory_from_trees(trees)
    if text_plan is not None:
        validate_text_plan_ids(text_plan, inventory)
    selected_border_marks = (
        set(text_plan["clear_border_fill_marks"]) if text_plan is not None else set()
    )
    reported_border_marks = {
        str(mark["id"]) for mark in border_fill_mark_inventory(trees)
    }
    unreported_border_marks = selected_border_marks - reported_border_marks
    if unreported_border_marks:
        raise ValueError(
            "text decision plan can clear only ids reported by visual_marks: "
            + ", ".join(sorted(unreported_border_marks)[:5])
        )
    cleared_border_marks = clear_border_fill_marks(
        trees,
        selected_border_marks,
    )
    reset_controls = reset_form_controls(
        trees,
        set(text_plan["reset_form_controls"]) if text_plan is not None else set(),
    )

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
    preserved_guidance: list[dict[str, str]] = []
    kept_paragraphs: list[dict[str, object]] = []
    removed_paragraphs: list[dict[str, object]] = []
    approved_visible_text: list[tuple[str, str]] = []
    for part, tree in trees.items():
        if is_document_xml(part):
            (
                part_stats,
                guidance,
                approved_fragments,
                part_kept,
                part_removed,
            ) = sanitize_document_tree(
                tree,
                part,
                removable_media,
                preserve_flow,
                preserve_guidance,
                text_plan,
            )
            totals.update(part_stats)
            preserved_guidance.extend(
                {"part": part, "text": text}
                for text in guidance
            )
            approved_visible_text.extend(approved_fragments)
            kept_paragraphs.extend(part_kept)
            removed_paragraphs.extend(part_removed)
    totals.update(sanitize_metadata(content_tree, title))
    manifest_removed_parts = removed_parts - set(PUBLISHABLE_PREVIEW_ENTRIES)
    totals["manifest_items_removed"] += scrub_manifest(content_tree, manifest_removed_parts)

    expected_fields = field_inventory_from_trees(trees)
    expected_controls = form_control_inventory_from_trees(trees)
    expected_named_attributes = named_attribute_inventory_from_trees(trees)
    if text_plan is not None and expected_fields != source_fields:
        raise ValueError("semantic text plan changed editable field structure")
    if text_plan is not None and expected_named_attributes != source_named_attributes:
        raise ValueError("semantic text plan changed reusable named structure")
    if text_plan is not None:
        structural_keys = ("id", "part", "kind", "paragraph_id", "name", "caption", "editable", "enabled")
        source_control_structure = [
            {key: control.get(key) for key in structural_keys}
            for control in source_controls
        ]
        expected_control_structure = [
            {key: control.get(key) for key in structural_keys}
            for control in expected_controls
        ]
        if expected_control_structure != source_control_structure:
            raise ValueError("semantic text plan changed form-control structure")

    for part, tree in trees.items():
        if part not in removed_parts:
            entries[part] = serialize_xml(tree, entries[part])
    for part in removed_parts:
        entries.pop(part, None)
    entries.update(PUBLISHABLE_PREVIEW_ENTRIES)
    totals["publishable_preview_entries_generated"] = len(PUBLISHABLE_PREVIEW_ENTRIES)

    write_archive(source, destination, infos, entries)
    try:
        verification = validate_output(
            destination,
            title,
            source_fingerprint,
            expected_visible_text=approved_visible_text,
        )
        output_inspection = inspect_hwpx(destination)
        if output_inspection["fields"] != expected_fields:
            raise ValueError("output changed editable field structure")
        if output_inspection["form_controls"] != expected_controls:
            raise ValueError("output changed form-control structure or state")
        if output_inspection["named_attributes"] != expected_named_attributes:
            raise ValueError("output changed reusable named structure")
        verification.update(
            {
                "editable_field_structure_match": True,
                "editable_field_count": len(expected_fields),
                "form_control_structure_match": True,
                "form_control_count": len(expected_controls),
                "named_structure_match": True,
                "named_attribute_count": len(expected_named_attributes),
            }
        )
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
        "preserved_guidance": preserved_guidance,
        "cleared_border_fill_marks": cleared_border_marks,
        "reset_form_controls": reset_controls,
        "generated_preview_entries": sorted(PUBLISHABLE_PREVIEW_ENTRIES),
        "text_decisions": (
            {
                "default": text_plan["default"],
                "explicit_keep_count": len(text_plan["keep"]),
                "explicit_remove_count": len(text_plan["remove"]),
                "replacement_count": len(text_plan["replace"]),
                "cleared_border_fill_mark_count": len(cleared_border_marks),
                "reset_form_control_count": len(reset_controls),
                "kept_count": len(kept_paragraphs),
                "removed_count": len(removed_paragraphs),
                "kept": kept_paragraphs,
                "removed": removed_paragraphs,
            }
            if text_plan is not None
            else None
        ),
        "changes": dict(totals),
        "text_strategy": (
            "source-bound semantic text plan"
            if text_plan is not None
            else "approved structure and instructions"
            if preserve_guidance
            else "width-aware blank spacing"
            if preserve_flow
            else "zero-width layout anchors"
        ),
        "verification": verification,
    }


def add_page_break_hints(
    source: Path,
    output: Path,
    count: int,
    title: str,
    expected_fingerprint: dict[str, object],
    expected_visible_text: Sequence[tuple[str, str]] = (),
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
        validate_output(
            output,
            title,
            expected_fingerprint,
            expected_visible_text=expected_visible_text,
        )
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
    expected_visible_text: Sequence[tuple[str, str]],
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
    # safe to ignore here because export-text above independently proved that
    # native visible text exactly matches the sanitized document, while all
    # other payload classes remain forbidden.
    roundtrip = validate_output(
        roundtrip_hwpx,
        None,
        expected_fingerprint,
        allow_generated_preview=True,
        require_geometry_hash=False,
        expected_visible_text=None,
    )
    return {
        "format": output_info.get("format"),
        "page_count": output_info.get("pageCount"),
        "sections": output_info.get("sections"),
        "content_text_nodes": len(expected_visible_text),
        "generated_layout_text_matches": True,
        "title": title,
        "title_verified_by": "output filename",
        "render_diff": render_diff,
        "roundtrip_hwpx": roundtrip,
    }


def approved_visible_text_from_report(
    report: dict[str, object],
) -> list[tuple[str, str]]:
    verification = report.get("verification")
    if not isinstance(verification, dict):
        raise ValueError("copy-layout report is missing verification")
    approved = verification.get("approved_visible_text")
    if not isinstance(approved, list):
        raise ValueError("copy-layout verification is missing approved visible text")
    fragments: list[tuple[str, str]] = []
    for item in approved:
        if not isinstance(item, dict):
            raise ValueError("invalid approved visible text record")
        part = item.get("part")
        text = item.get("text")
        if not isinstance(part, str) or not isinstance(text, str):
            raise ValueError("invalid approved visible text value")
        fragments.append((part, text))
    return fragments


def copy_layout(
    source: Path,
    output: Path | None,
    keep_media: set[str],
    rhwp_binary: Path | None = None,
    preserve_guidance: bool = False,
    text_plan_path: Path | None = None,
) -> dict[str, object]:
    source = source.expanduser().resolve()
    source_format = source.suffix.lower()
    if not source.is_file() or source_format not in {".hwp", ".hwpx"}:
        raise ValueError(f"source is not an HWP or HWPX file: {source}")
    if preserve_guidance and text_plan_path is not None:
        raise ValueError("use either --preserve-guidance or --text-plan, not both")
    text_plan = load_text_plan(text_plan_path, source) if text_plan_path is not None else None
    destination, title = output_path_for(source, output)
    output_format = destination.suffix.lower()

    if source_format == ".hwpx" and output_format == ".hwpx":
        report = sanitize_hwpx(
            source,
            destination,
            title,
            keep_media,
            preserve_guidance=preserve_guidance,
            text_plan=text_plan,
        )
        report.update(
            {
                "source": str(source),
                "output": str(destination),
                "input_format": "hwpx",
                "output_format": "hwpx",
                "conversion": None,
            }
        )
        return set_delivery(report)

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
                preserve_guidance=preserve_guidance,
                text_plan=text_plan,
            )
            native_verification: dict[str, object] | None = None
            fidelity_warnings: list[str] = []
            if output_format == ".hwp":
                try:
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
                            preserve_guidance=preserve_guidance,
                            text_plan=text_plan,
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
                            approved_visible_text_from_report(report),
                        )
                        report["changes"]["inferred_page_breaks"] = added
                        destination.unlink(missing_ok=True)
                        sanitized_hwpx = page_hints
                        run_rhwp(
                            binary,
                            ["convert", str(sanitized_hwpx), str(destination), "--verify-pages"],
                        )
                    native_verification = verify_native_output(
                        binary,
                        source,
                        destination,
                        title,
                        report["verification"]["layout"],
                        approved_visible_text_from_report(report),
                        sanitized_hwpx,
                        temporary / "roundtrip.hwpx",
                    )
                except (OSError, ValueError, zipfile.BadZipFile) as exc:
                    return deliver_hwpx_fallback(
                        destination,
                        sanitized_hwpx,
                        report,
                        source,
                        source_format,
                        binary,
                        exc,
                        intermediate_export,
                    )
            else:
                try:
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
                            preserve_guidance=preserve_guidance,
                            text_plan=text_plan,
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
                            approved_visible_text_from_report(report),
                        )
                        report["changes"]["inferred_page_breaks"] = added
                        destination.unlink(missing_ok=True)
                        shutil.copy2(page_hints, destination)
                        sanitized_hwpx = destination
                        output_info = native_document_info(binary, destination)
                        output_page_count = output_info.get("pageCount")
                    if source_info.get("pageCount") != output_info.get("pageCount"):
                        fidelity_warnings.append(
                            "final HWPX pageCount changed: "
                            f"{source_info.get('pageCount')!r} -> {output_info.get('pageCount')!r}"
                        )
                    native_verification = {
                        "format": output_info.get("format"),
                        "page_count": output_info.get("pageCount"),
                        "sections": output_info.get("sections"),
                    }
                except (OSError, ValueError, zipfile.BadZipFile) as exc:
                    fidelity_warnings.append(f"final HWPX fidelity comparison failed: {exc}")
                    if not destination.is_file() and sanitized_hwpx.is_file():
                        shutil.copy2(sanitized_hwpx, destination)
                    native_verification = {"unavailable": str(exc)}

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
            return set_delivery(report, fidelity_warnings)
    except Exception:
        destination.unlink(missing_ok=True)
        raise


def inspect_document(source: Path, rhwp_binary: Path | None = None) -> dict[str, object]:
    source = source.expanduser().resolve()
    source_format = source.suffix.lower()
    if not source.is_file() or source_format not in {".hwp", ".hwpx"}:
        raise ValueError(f"source is not an HWP or HWPX file: {source}")
    if source_format == ".hwpx":
        report = inspect_hwpx(source)
        report["input_format"] = "hwpx"
        report["conversion"] = None
        return report

    binary = resolve_rhwp_binary(rhwp_binary)
    with tempfile.TemporaryDirectory(prefix="copy-layout-inspect-") as temporary_directory:
        intermediate = Path(temporary_directory) / "source.hwpx"
        conversion = export_hwpx_for_sanitization(binary, source, intermediate)
        report = inspect_hwpx(intermediate, identity_source=source)
        report["input_format"] = "hwp"
        report["conversion"] = {
            "engine": str(binary),
            "intermediate_export": conversion,
        }
        return report


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path, help="source .hwp or .hwpx document")
    parser.add_argument("-o", "--output", type=Path, help="explicit output .hwp or .hwpx path")
    parser.add_argument(
        "--inspect-text",
        action="store_true",
        help="emit source-bound paragraph inventory JSON without creating a layout copy",
    )
    parser.add_argument(
        "--text-plan",
        type=Path,
        help="JSON keep/remove plan created from --inspect-text output",
    )
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
    parser.add_argument(
        "--preserve-guidance",
        action="store_true",
        help=(
            "retain conservative structure headings and imperative instructions "
            "for competition or assignment templates"
        ),
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    try:
        if args.inspect_text:
            if args.output or args.text_plan or args.keep_media or args.preserve_guidance:
                raise ValueError(
                    "--inspect-text cannot be combined with output or sanitization options"
                )
            report = inspect_document(args.source, args.rhwp_bin)
        else:
            report = copy_layout(
                args.source,
                args.output,
                set(args.keep_media),
                args.rhwp_bin,
                args.preserve_guidance,
                args.text_plan,
            )
    except (FileExistsError, OSError, ValueError, zipfile.BadZipFile) as exc:
        print(f"copy-layout: {exc}", file=sys.stderr)
        return 1
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
