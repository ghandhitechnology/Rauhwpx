#!/usr/bin/env python3
"""Build auditable OpenType/CFF fonts from isolated Hancom vector atlas PDFs.

The manifest owns Unicode, source advances, and the PDF-to-em anchors. This
tool never infers a character from its appearance or substitutes raster ink.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
from pathlib import Path

import pymupdf
import pathops
from fontTools.fontBuilder import FontBuilder
from fontTools.misc.roundTools import otRound
from fontTools.pens.boundsPen import BoundsPen
from fontTools.pens.recordingPen import RecordingPen
from fontTools.pens.t2CharStringPen import T2CharStringPen
from fontTools.ttLib import TTFont


VERSION = 1
TOLERANCE_PT = 0.25
HFT_NAME_MARKER = "rhwp:source-format=HFT;metrics=source-hmtx-v1"


class AtlasError(ValueError):
    pass


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def codepoint(entry: dict) -> int:
    raw = entry["codepoint"]
    value = int(raw[2:], 16) if isinstance(raw, str) and raw.startswith("U+") else int(raw)
    if not 0 <= value <= 0x10FFFF or 0xD800 <= value <= 0xDFFF:
        raise AtlasError(f"invalid Unicode codepoint: {raw}")
    if entry.get("char") is not None and entry["char"] != chr(value):
        raise AtlasError(f"character disagrees with {raw}")
    return value


def glyph_name(cp: int) -> str:
    return f"uni{cp:04X}" if cp <= 0xFFFF else f"u{cp:06X}"


def source_advance(cp: int, banks: dict[str, tuple[dict, bytes]]) -> int:
    if 0x20 <= cp <= 0x7E:
        encoding = "latin_hft_0x20_0x85"
        index = cp - 0x20
    else:
        try:
            encoded = chr(cp).encode("euc_kr")
        except UnicodeEncodeError as error:
            raise AtlasError(f"no verified HFT mapping U+{cp:04X}") from error
        if len(encoded) != 2 or not 0xA1 <= encoded[1] <= 0xFE:
            raise AtlasError(f"no verified HFT mapping U+{cp:04X}")
        if 0xB0 <= encoded[0] <= 0xC8:
            encoding = "ks_x_1001_hangul_2350"
        elif 0xCA <= encoded[0] <= 0xFD:
            encoding = "ks_x_1001_hanja_4888"
        else:
            raise AtlasError(f"no verified HFT mapping U+{cp:04X}")
        index = 0  # These record-type-0 banks declare one shared advance.
    if encoding not in banks:
        raise AtlasError(f"missing HFT bank for U+{cp:04X}")
    bank, raw = banks[encoding]
    if bank.get("record_type") != (1 if encoding.startswith("latin") else 0):
        raise AtlasError(f"unsupported HFT width record at U+{cp:04X}")
    offset = bank["width_table_offset"] + 10 + 2 * index
    if offset + 2 > len(raw):
        raise AtlasError(f"HFT width table truncated at U+{cp:04X}")
    return int.from_bytes(raw[offset:offset + 2], "little")


def require_manifest(path: Path, hft_dir: Path) -> tuple[dict, Path]:
    data = json.loads(path.read_text())
    if data.get("schema_version") != 1:
        raise AtlasError("unsupported manifest schema")
    pdf = Path(data["pdf"])
    if not pdf.is_absolute():
        pdf = path.parent / pdf
    if not pdf.is_file() or not data.get("pdf_sha256"):
        raise AtlasError("PDF and its SHA-256 are required")
    if sha256(pdf) != data["pdf_sha256"]:
        raise AtlasError("PDF SHA-256 mismatch")
    source = Path(data["source_hwpx"])
    if not source.is_absolute():
        source = path.parent / source
    if not source.is_file() or sha256(source) != data["source_hwpx_sha256"]:
        raise AtlasError("source HWPX SHA-256 mismatch")
    if not data.get("hft_banks"):
        raise AtlasError("source HFT bank hashes are required")
    banks = {}
    for bank in data["hft_banks"]:
        source_bank = hft_dir / bank["filename"]
        if not source_bank.is_file() or sha256(source_bank) != bank["sha256"]:
            raise AtlasError(f"source HFT bank missing or changed: {bank['filename']}")
        if bank["encoding"] in banks:
            raise AtlasError(f"duplicate HFT bank encoding {bank['encoding']}")
        banks[bank["encoding"]] = (bank, source_bank.read_bytes())
    if not data.get("entries"):
        raise AtlasError("empty atlas")
    vertical = data.get("vertical_metrics")
    if (not vertical or not data.get("vertical_metrics_basis")
            or not isinstance(vertical.get("ascender_units"), int)
            or not isinstance(vertical.get("descender_units"), int)
            or not isinstance(vertical.get("line_gap_units"), int)
            or vertical["ascender_units"] <= 0 or vertical["descender_units"] >= 0):
        raise AtlasError("vertical metrics and provenance are required")
    if data.get("style") not in {"Regular", "Bold", "Italic", "Bold Italic"}:
        raise AtlasError("unsupported style metadata")
    expected_weight = 700 if "Bold" in data["style"] else 400
    if data.get("font_weight", expected_weight) != expected_weight:
        raise AtlasError("font weight disagrees with style")
    if "Italic" in data["style"] and (
            not isinstance(data.get("italic_angle_deg"), (int, float))
            or not data.get("italic_angle_basis")):
        raise AtlasError("italic angle and provenance are required")
    seen = set()
    for entry in data["entries"]:
        cp = codepoint(entry)
        if cp in seen:
            raise AtlasError(f"duplicate U+{cp:04X}")
        seen.add(cp)
        if entry.get("font_family") != data["font_family"] or entry.get("style") != data["style"]:
            raise AtlasError(f"mixed font family/style at U+{cp:04X}")
        if not isinstance(entry.get("advance_units"), int) or entry["advance_units"] <= 0:
            raise AtlasError(f"missing source advance at U+{cp:04X}")
        if entry.get("source_hft_advance_units") != entry["advance_units"]:
            raise AtlasError(f"advance differs from source HFT at U+{cp:04X}")
        if source_advance(cp, banks) != entry["advance_units"]:
            raise AtlasError(f"advance differs from HFT bytes at U+{cp:04X}")
        if entry.get("expected_status") not in {"ink", "source_verified_blank", "rejected_raster"}:
            raise AtlasError(f"unsupported status at U+{cp:04X}")
        if entry.get("expected_status") == "source_verified_blank":
            proof = entry.get("blank_proof")
            if not proof:
                raise AtlasError(f"blank requires proof at U+{cp:04X}")
            if (proof.get("source_hft_advance_units") != entry["advance_units"]
                    or proof.get("source_hft_bank") not in {
                        bank["filename"] for bank in data["hft_banks"]}):
                raise AtlasError(f"blank source proof differs from HFT at U+{cp:04X}")
        if entry.get("font_size_pt", 0) <= 0 or entry.get("em_units", 0) <= 0:
            raise AtlasError(f"invalid font size/em at U+{cp:04X}")
        if len(entry.get("cell_rect_pt", [])) != 4 or len(entry.get("origin_pt", [])) != 2:
            raise AtlasError(f"missing PDF cell/origin at U+{cp:04X}")
        if entry.get("max_path_protrusion_pt", 0):
            if (entry.get("protrusion_basis") != "pdf_clip_extends_above_cell"
                    or not 0 < entry["max_path_protrusion_pt"] <= 1):
                raise AtlasError(f"unverified path protrusion at U+{cp:04X}")
    return data, pdf


def point_xy(point) -> tuple[float, float]:
    return float(point.x), float(point.y)


def path_commands(drawing: dict) -> list[list]:
    """Convert PyMuPDF's already transformed PDF path into closed contours."""
    commands: list[list] = []
    first = None
    previous = None

    def start(point):
        nonlocal first, previous
        x, y = point_xy(point)
        if previous is None or math.hypot(x - previous[0], y - previous[1]) > 0.02:
            if previous is not None:
                commands.append(["Z"])
            commands.append(["M", x, y])
            first = (x, y)
        previous = (x, y)

    for item in drawing["items"]:
        kind = item[0]
        if kind == "l":
            start(item[1])
            x, y = point_xy(item[2])
            commands.append(["L", x, y])
            previous = (x, y)
        elif kind == "c":
            start(item[1])
            coords = [v for point in item[2:5] for v in point_xy(point)]
            commands.append(["C", *coords])
            previous = tuple(coords[-2:])
        elif kind == "re":
            rect, orientation = item[1:3]
            corners = [(rect.x0, rect.y0), (rect.x1, rect.y0),
                       (rect.x1, rect.y1), (rect.x0, rect.y1)]
            if orientation < 0:
                corners.reverse()
            if previous is not None:
                commands.append(["Z"])
            commands.append(["M", *corners[0]])
            commands.extend(["L", *p] for p in corners[1:])
            commands.append(["Z"])
            first = previous = None
        elif kind == "qu":
            quad = item[1]
            corners = [point_xy(p) for p in (quad.ul, quad.ur, quad.lr, quad.ll)]
            if previous is not None:
                commands.append(["Z"])
            commands.append(["M", *corners[0]])
            commands.extend(["L", *p] for p in corners[1:])
            commands.append(["Z"])
            first = previous = None
        else:
            raise AtlasError(f"unsupported PDF path operator {kind}")
    if previous is not None:
        commands.append(["Z"])
    if not commands or commands[0][0] != "M":
        raise AtlasError("empty or malformed PDF vector path")
    return commands


def inside(outer: pymupdf.Rect, inner: pymupdf.Rect, tolerance=TOLERANCE_PT) -> bool:
    return (inner.x0 >= outer.x0 - tolerance and inner.y0 >= outer.y0 - tolerance
            and inner.x1 <= outer.x1 + tolerance and inner.y1 <= outer.y1 + tolerance)


def image_placements(page) -> list[dict]:
    return page.get_image_info(xrefs=True)


def rendered_cell_is_blank(page, cell: pymupdf.Rect) -> bool:
    """Check PDF compositing, not encoded mask samples, on transparent canvas."""
    pixmap = page.get_pixmap(matrix=pymupdf.Matrix(2, 2), clip=cell, alpha=True)
    if not pixmap.alpha or pixmap.n != 4:
        raise AtlasError("blank-cell render lacks RGBA alpha")
    return not any(pixmap.samples[3::4])


def normalize_commands(commands: list[list], origin_x: float, baseline_y: float,
                       scale: float) -> list[list]:
    result = []
    for command in commands:
        if command[0] == "Z":
            result.append(command)
        else:
            coords = []
            for x, y in zip(command[1::2], command[2::2]):
                coords.extend([round((x - origin_x) * scale, 3),
                               round((baseline_y - y) * scale, 3)])
            result.append([command[0], *coords])
    return result


def skia_path(commands: list[list], even_odd: bool = False) -> pathops.Path:
    path = pathops.Path(fillType=pathops.FillType.EVEN_ODD
                        if even_odd else pathops.FillType.WINDING)
    for command in commands:
        if command[0] == "M":
            path.moveTo(*command[1:3])
        elif command[0] == "L":
            path.lineTo(*command[1:3])
        elif command[0] == "C":
            path.cubicTo(*command[1:7])
        elif command[0] == "Z":
            path.close()
        else:
            raise AtlasError(f"unsupported normalized operator {command[0]}")
    return path


def commands_from_skia(path: pathops.Path) -> list[list]:
    path.convertConicsToQuads(0.05)
    commands = []
    previous = None
    for verb, points in path:
        if verb == pathops.PathVerb.MOVE:
            previous = points[0]
            commands.append(["M", *previous])
        elif verb == pathops.PathVerb.LINE:
            previous = points[0]
            commands.append(["L", *previous])
        elif verb == pathops.PathVerb.CUBIC:
            commands.append(["C", *(value for point in points for value in point)])
            previous = points[-1]
        elif verb == pathops.PathVerb.QUAD:
            if previous is None:
                raise AtlasError("quadratic segment has no start")
            control, endpoint = points
            first = tuple(previous[i] + 2 / 3 * (control[i] - previous[i]) for i in (0, 1))
            second = tuple(endpoint[i] + 2 / 3 * (control[i] - endpoint[i]) for i in (0, 1))
            commands.append(["C", *first, *second, *endpoint])
            previous = endpoint
        elif verb == pathops.PathVerb.CLOSE:
            commands.append(["Z"])
            previous = None
        else:
            raise AtlasError(f"unsupported stroke outline operator {verb}")
    if not commands or commands[0][0] != "M":
        raise AtlasError("stroke expansion produced empty outline")
    return commands


def paint_commands(draw: dict, commands: list[list], entry: dict, manifest: dict) -> list[list]:
    """Represent PDF fill and stroke as one winding CFF outline."""
    if draw["type"] not in {"f", "fs"} or draw.get("fill") != (0.0, 0.0, 0.0):
        raise AtlasError("unsupported glyph paint")
    if draw.get("fill_opacity") != 1.0:
        raise AtlasError("translucent glyph fill")
    stroke = draw["type"] == "fs" and draw.get("stroke_opacity", 0) > 0
    if not stroke and not draw.get("even_odd"):
        return commands
    fill = skia_path(commands, bool(draw.get("even_odd")))
    if stroke:
        profile = manifest.get("stroke_profile")
        if not profile or not profile.get("basis") or (
                profile.get("line_cap"), profile.get("line_join"),
                profile.get("miter_limit"), profile.get("dash")) != (
                "butt", "miter", 10, "solid"):
            raise AtlasError("visible stroke lacks audited PDF paint profile")
        if (draw.get("stroke_opacity") != 1.0 or draw.get("color") != (0.0, 0.0, 0.0)
                or tuple(draw.get("lineCap", ())) != (0, 0, 0)
                or draw.get("lineJoin") != 0.0 or draw.get("dashes") != "[] 0"):
            raise AtlasError("unsupported glyph stroke paint")
        width = draw.get("width", 0) * entry["em_units"] / entry["font_size_pt"]
        if not 0 < width <= 100:
            raise AtlasError("invalid glyph stroke width")
        if (not isinstance(profile.get("source_width_units"), (int, float))
                or abs(width - profile["source_width_units"]) > 0.01):
            raise AtlasError("PDF stroke width differs from audited source units")
        painted_stroke = pathops.Path(fill)
        painted_stroke.stroke(width, pathops.LineCap.BUTT_CAP,
                              pathops.LineJoin.MITER_JOIN, 10)
        painted_stroke.convertConicsToQuads(0.05)
        painted_stroke = pathops.simplify(painted_stroke)
        try:
            painted = pathops.op(fill, painted_stroke, pathops.PathOp.UNION)
        except pathops.PathOpsError as error:
            raise AtlasError(f"stroke union failed at {entry['codepoint']}") from error
    else:
        painted = pathops.simplify(fill)
    if painted.fillType != pathops.FillType.WINDING:
        raise AtlasError("paint expansion did not produce nonzero winding")
    return commands_from_skia(painted)


def extract(data: dict, pdf: Path) -> dict:
    document = pymupdf.open(pdf)
    if len(document) != data["page_count_expected"]:
        raise AtlasError("PDF page count differs from atlas")
    drawings = [page.get_drawings() for page in document]
    images = [image_placements(page) for page in document]
    for page_index, page in enumerate(document):
        if any(block["type"] == 0 for block in page.get_text("rawdict")["blocks"]):
            raise AtlasError(f"PDF page {page_index + 1} contains live text/fallback font")
    used_drawings: set[tuple[int, int]] = set()
    glyphs = []
    for entry in data["entries"]:
        cp = codepoint(entry)
        page_index = entry["page"] - 1
        if not 0 <= page_index < len(document):
            raise AtlasError(f"invalid page for U+{cp:04X}")
        cell = pymupdf.Rect(entry["cell_rect_pt"])
        page = document[page_index]
        if not inside(page.rect, cell):
            raise AtlasError(f"cell outside page at U+{cp:04X}")
        # PDF paths can protrude a fraction of a point past their clipping cell.
        # Assign by center so that a neighboring row's protrusion is not stolen;
        # the full path must still fit the cell to a small PDF rounding tolerance.
        hits = [(index, draw) for index, draw in enumerate(drawings[page_index])
                if cell.contains((draw["rect"].tl + draw["rect"].br) / 2)]
        image_hits = [image for image in images[page_index]
                      if pymupdf.Rect(image["bbox"]).intersects(cell)]
        status = entry["expected_status"]
        if status == "rejected_raster":
            if not image_hits:
                raise AtlasError(f"rejected-raster cell lacks expected image at U+{cp:04X}")
            continue
        if status == "source_verified_blank":
            if hits:
                raise AtlasError(f"source-blank cell has vector ink at U+{cp:04X}")
            # A blank placeholder image is accepted only if the manifest's proof
            # matches its actual XObject and every decoded alpha sample is zero.
            proof = entry["blank_proof"]
            if image_hits:
                if len(image_hits) != 1 or image_hits[0]["xref"] != proof.get("pdf_image_xref"):
                    raise AtlasError(f"unverified image in blank cell U+{cp:04X}")
                image = document.extract_image(image_hits[0]["xref"])
                samples = pymupdf.Pixmap(image["image"]).samples
                if (not proof.get("pdf_image_all_alpha_zero") or any(samples)
                        or hashlib.sha256(samples).hexdigest()
                        != proof.get("pdf_image_samples_sha256")):
                    raise AtlasError(f"nonblank or unverified image U+{cp:04X}")
            if not rendered_cell_is_blank(page, cell):
                raise AtlasError(f"blank cell paints visible ink U+{cp:04X}")
        elif image_hits:
            raise AtlasError(f"raster content in ink cell U+{cp:04X}")
        elif not hits:
            raise AtlasError(f"missing vector glyph U+{cp:04X}")
        contours = []
        origin_x, _ = entry["origin_pt"]
        baseline_y = entry["baseline_pt"]
        scale = entry["em_units"] / entry["font_size_pt"]
        for index, draw in hits:
            if (page_index, index) in used_drawings:
                raise AtlasError(f"PDF path assigned to two cells at U+{cp:04X}")
            # Most atlas vectors must fit their clipping cell. A small top
            # protrusion is permitted only when audited in the manifest; the
            # source outline remains intact even where the PDF clip masks it.
            if not inside(cell, draw["rect"]):
                permitted_top = entry.get("max_path_protrusion_pt", 0)
                if (not permitted_top or draw["rect"].y0 < cell.y0 - permitted_top
                        or draw["rect"].x0 < cell.x0 - TOLERANCE_PT
                        or draw["rect"].x1 > cell.x1 + TOLERANCE_PT
                        or draw["rect"].y1 > cell.y1 + TOLERANCE_PT):
                    raise AtlasError(f"PDF vector crosses cell boundary U+{cp:04X}")
            normalized = normalize_commands(path_commands(draw), origin_x,
                                            baseline_y, scale)
            contours.extend(paint_commands(draw, normalized, entry, data))
            used_drawings.add((page_index, index))
        glyphs.append({"codepoint": cp, "glyph_name": glyph_name(cp),
                       "advance_units": entry["advance_units"], "commands": contours,
                       "status": status, "drawing_count": len(hits),
                       "source_entry": entry})
    # A grid may contain empty unused cells, but every vector mark must belong to exactly one
    # manifest entry. This catches omitted coverage and table decorations.
    stray = [(p + 1, i) for p, page_drawings in enumerate(drawings)
             for i in range(len(page_drawings)) if (p, i) not in used_drawings]
    if stray:
        raise AtlasError(f"{len(stray)} unassigned PDF vector paths, first {stray[:8]}")
    return {"schema_version": 1, "tool_version": VERSION,
            "font_family": data["font_family"], "style": data["style"],
            "font_weight": data.get("font_weight", 700 if "Bold" in data["style"] else 400),
            "italic_angle_deg": data.get("italic_angle_deg", 0),
            "italic_angle_basis": data.get("italic_angle_basis", "upright"),
            "vertical_metrics": data["vertical_metrics"],
            "vertical_metrics_basis": data["vertical_metrics_basis"],
            "manifest_sha256": hashlib.sha256(json.dumps(data, sort_keys=True).encode()).hexdigest(),
            "pdf_sha256": data["pdf_sha256"], "glyphs": glyphs}


def draw_commands(pen, commands: list[list]) -> None:
    for command in commands:
        op = command[0]
        if op == "M":
            pen.moveTo(tuple(command[1:3]))
        elif op == "L":
            pen.lineTo(tuple(command[1:3]))
        elif op == "C":
            pen.curveTo(tuple(command[1:3]), tuple(command[3:5]), tuple(command[5:7]))
        elif op == "Z":
            pen.closePath()
        else:
            raise AtlasError(f"bad normalized path op {op}")


def charstring_commands(commands: list[list]) -> list[list]:
    """Match CFF integer serialization and discard collapsed line segments."""
    result = []
    previous = None
    for command in commands:
        current = [command[0], *(otRound(value) for value in command[1:])]
        if current[0] == "L" and previous == tuple(current[1:3]):
            continue
        if current[0] == "C" and previous is not None and (
                tuple(current[1:3]) == previous
                and tuple(current[3:5]) == previous
                and tuple(current[5:7]) == previous):
            continue
        result.append(current)
        if current[0] in {"M", "L", "C"}:
            previous = tuple(current[-2:])
        elif current[0] == "Z":
            previous = None
    return result


def build(outlines: dict, output: Path) -> dict:
    glyphs = outlines["glyphs"]
    if not glyphs:
        raise AtlasError("no accepted glyphs")
    upm_values = {g["source_entry"]["em_units"] for g in glyphs}
    if len(upm_values) != 1:
        raise AtlasError("mixed units per em")
    upm = upm_values.pop()
    family, style = outlines["font_family"], outlines["style"]
    vertical = outlines["vertical_metrics"]
    ascender = vertical["ascender_units"]
    descender = vertical["descender_units"]
    line_gap = vertical["line_gap_units"]
    bold = style in {"Bold", "Bold Italic"}
    italic = style in {"Italic", "Bold Italic"}
    postscript = "HancomAtlas-" + hashlib.sha256((family + style).encode()).hexdigest()[:12]
    order = [".notdef"] + [g["glyph_name"] for g in glyphs]
    charstrings = {}
    metrics = {".notdef": (upm, 0)}
    ink_top = ink_bottom = 0
    empty = T2CharStringPen(upm, None)
    charstrings[".notdef"] = empty.getCharString()
    for glyph in glyphs:
        advance = glyph["advance_units"]
        commands = charstring_commands(glyph["commands"])
        pen = T2CharStringPen(advance, None)
        draw_commands(pen, commands)
        charstrings[glyph["glyph_name"]] = pen.getCharString()
        bounds_pen = BoundsPen(None)
        draw_commands(bounds_pen, commands)
        if bounds_pen.bounds:
            ink_bottom = min(ink_bottom, math.floor(bounds_pen.bounds[1]))
            ink_top = max(ink_top, math.ceil(bounds_pen.bounds[3]))
        metrics[glyph["glyph_name"]] = (
            advance, math.floor(bounds_pen.bounds[0]) if bounds_pen.bounds else 0)
    fb = FontBuilder(upm, isTTF=False)
    fb.setupGlyphOrder(order)
    fb.setupCharacterMap({g["codepoint"]: g["glyph_name"] for g in glyphs})
    # CFF top-dict strings are Latin-1; OpenType name records retain the
    # original Unicode Hancom family/style for browser and native matching.
    fb.setupCFF(postscript, {"FullName": postscript, "FamilyName": postscript,
                            "Weight": style}, charstrings, {})
    fb.setupHorizontalMetrics(metrics)
    fb.setupHorizontalHeader(ascent=ascender, descent=descender, lineGap=line_gap)
    fb.setupNameTable({"familyName": family, "styleName": style,
                       "uniqueFontIdentifier": postscript + ":" + outlines["manifest_sha256"][:16],
                       "fullName": family + " " + style, "psName": postscript,
                       "description": HFT_NAME_MARKER})
    fb.setupOS2(version=4, sTypoAscender=ascender, sTypoDescender=descender,
                sTypoLineGap=line_gap, usWinAscent=max(ascender, ink_top),
                usWinDescent=max(-descender, -ink_bottom),
                usWeightClass=outlines["font_weight"],
                fsSelection=(1 if italic else 0) | (32 if bold else 0)
                | (64 if not bold and not italic else 0) | (128 if not italic else 0))
    fb.setupPost(italicAngle=outlines["italic_angle_deg"])
    fb.setupMaxp()
    # 1970-01-01 in OpenType's 1904 epoch: deterministic and widely accepted.
    fb.setupHead(created=2082844800, modified=2082844800)
    fb.font["head"].macStyle = (1 if bold else 0) | (2 if italic else 0)
    fb.font.recalcTimestamp = False
    output.parent.mkdir(parents=True, exist_ok=True)
    fb.save(output)
    audit = verify_font(outlines, output)
    return {"font": str(output), "font_sha256": sha256(output), "postscript": postscript,
            "family": family, "style": style, "units_per_em": upm,
            "font_weight": outlines["font_weight"],
            "italic_angle_deg": outlines["italic_angle_deg"],
            "italic_angle_basis": outlines["italic_angle_basis"],
            "vertical_metrics": vertical,
            "vertical_metrics_basis": outlines["vertical_metrics_basis"],
            "win_ascent": max(ascender, ink_top),
            "win_descent": max(-descender, -ink_bottom),
            "glyph_count": len(glyphs), "cmap": [f"U+{cp:04X}" for cp in sorted(audit["cmap"])],
            "max_outline_area_delta_units2": audit["max_outline_area_delta_units2"],
            "manifest_sha256": outlines["manifest_sha256"], "pdf_sha256": outlines["pdf_sha256"]}


def verify_font(outlines: dict, font_path: Path) -> dict:
    """Read the serialized font back and compare every mapped contour/advance."""
    font = TTFont(font_path)
    glyphs = outlines["glyphs"]
    cmap = font.getBestCmap()
    expected = {g["codepoint"]: g["glyph_name"] for g in glyphs}
    if cmap != expected:
        raise AtlasError("saved cmap differs from verified atlas")
    if any(font["hmtx"][g["glyph_name"]][0] != g["advance_units"] for g in glyphs):
        raise AtlasError("saved hmtx differs from source advances")
    if ".notdef" in cmap.values() or font["CFF "] is None:
        raise AtlasError("invalid CFF cmap or missing-glyph routing")
    maximum_area_delta = 0.0
    glyph_set = font.getGlyphSet()
    for glyph in glyphs:
        pen = RecordingPen()
        glyph_set[glyph["glyph_name"]].draw(pen)
        commands = []
        for op, points in pen.value:
            symbol = {"moveTo": "M", "lineTo": "L", "curveTo": "C",
                      "closePath": "Z"}.get(op)
            if symbol is None:
                raise AtlasError(f"unsupported saved CFF operator {op}")
            commands.append([symbol, *(value for point in points for value in point)])
        expected_commands = charstring_commands(glyph["commands"])
        if bool(commands) != bool(expected_commands):
            raise AtlasError(f"serialized ink status differs U+{glyph['codepoint']:04X}")
        if commands:
            desired = skia_path(expected_commands)
            actual = skia_path(commands)
            delta = pathops.op(desired, actual, pathops.PathOp.XOR)
            maximum_area_delta = max(maximum_area_delta, abs(delta.area))
            if abs(delta.area) > 0.05:
                raise AtlasError(f"serialized outline geometry differs U+{glyph['codepoint']:04X}")
    if font["head"].unitsPerEm != glyphs[0]["source_entry"]["em_units"]:
        raise AtlasError("saved em differs from atlas")
    if font["name"].getDebugName(10) != HFT_NAME_MARKER:
        raise AtlasError("saved HFT provenance marker differs")
    return {"font_sha256": sha256(font_path), "glyph_count": len(glyphs),
            "cmap": cmap,
            "max_outline_area_delta_units2": round(maximum_area_delta, 3)}


def load_outlines(path: Path) -> dict:
    outlines = json.loads(path.read_text())
    if (outlines.get("schema_version") != 1 or outlines.get("tool_version") != VERSION
            or not outlines.get("glyphs") or not outlines.get("manifest_sha256")):
        raise AtlasError("unsupported or incomplete outline artifact")
    return outlines


def write_json(path: Path, value: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n")


def compare_scales(first: dict, second: dict) -> dict:
    """Check design-unit geometry is independent of Hancom export font size."""
    a = {g["codepoint"]: g for g in first["glyphs"]}
    b = {g["codepoint"]: g for g in second["glyphs"]}
    if a.keys() != b.keys():
        raise AtlasError("two-size control cmap differs")
    maximum = 0.0
    coordinates = 0
    for cp in a:
        if a[cp]["advance_units"] != b[cp]["advance_units"]:
            raise AtlasError(f"two-size advance differs U+{cp:04X}")
        one, two = a[cp]["commands"], b[cp]["commands"]
        if len(one) != len(two):
            raise AtlasError(f"two-size contour count differs U+{cp:04X}")
        for command, counterpart in zip(one, two):
            if command[0] != counterpart[0] or len(command) != len(counterpart):
                raise AtlasError(f"two-size contour structure differs U+{cp:04X}")
            for value, other in zip(command[1:], counterpart[1:]):
                maximum = max(maximum, abs(value - other))
                coordinates += 1
    if maximum > 0.75:
        raise AtlasError(f"two-size geometry drift {maximum:.3f} units exceeds 0.75")
    return {"glyph_count": len(a), "compared_coordinates": coordinates,
            "max_design_unit_delta": round(maximum, 3), "tolerance_units": 0.75,
            "first_manifest_sha256": first["manifest_sha256"],
            "second_manifest_sha256": second["manifest_sha256"]}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    for name in ("extract", "run"):
        sub = commands.add_parser(name, help="validate sources and extract PDF vectors"
                                  if name == "extract" else "extract, build, verify, and cache")
        sub.add_argument("manifest", type=Path)
        sub.add_argument("--hft-dir", type=Path, required=True)
        sub.add_argument("--out", type=Path, required=True)
        if name == "run":
            sub.add_argument("--force", action="store_true")
    sub = commands.add_parser("build", help="build and verify CFF from extracted outlines")
    sub.add_argument("outlines", type=Path)
    sub.add_argument("--out", type=Path, required=True)
    sub = commands.add_parser("verify", help="verify cmap, widths, and contours in saved OTF")
    sub.add_argument("outlines", type=Path)
    sub.add_argument("font", type=Path)
    sub.add_argument("--out", type=Path)
    sub = commands.add_parser("compare-scales", help="compare normalized paths from two font sizes")
    sub.add_argument("first", type=Path)
    sub.add_argument("second", type=Path)
    sub.add_argument("--out", type=Path)
    args = parser.parse_args()
    if args.command in {"extract", "run"}:
        manifest, pdf = require_manifest(args.manifest, args.hft_dir)
        source_signature = {
            "manifest_sha256": hashlib.sha256(json.dumps(manifest, sort_keys=True).encode()).hexdigest(),
            "pdf_sha256": manifest["pdf_sha256"],
            "source_hwpx_sha256": manifest["source_hwpx_sha256"],
            "hft_sha256": [bank["sha256"] for bank in manifest["hft_banks"]],
            "tool_sha256": sha256(Path(__file__))}
        if args.command == "run":
            receipt = args.out.with_suffix(".receipt.json")
            if args.out.is_file() and receipt.is_file() and not args.force:
                previous = json.loads(receipt.read_text())
                if (all(previous.get(k) == v for k, v in source_signature.items())
                        and previous.get("font_sha256") == sha256(args.out)):
                    print(json.dumps({"cached": True, "font": str(args.out),
                                      "font_sha256": previous["font_sha256"]}))
                    return
        outlines = extract(manifest, pdf)
        outlines.update({key: value for key, value in source_signature.items()
                         if key not in outlines})
        if args.command == "extract":
            write_json(args.out, outlines)
            result = {"outlines": str(args.out), "glyph_count": len(outlines["glyphs"]),
                      **source_signature}
        else:
            result = build(outlines, args.out)
            result.update(source_signature)
            write_json(receipt, result)
    elif args.command == "build":
        result = build(load_outlines(args.outlines), args.out)
        write_json(args.out.with_suffix(".receipt.json"), result)
    elif args.command == "verify":
        result = verify_font(load_outlines(args.outlines), args.font)
        if args.out:
            write_json(args.out, {k: v for k, v in result.items() if k != "cmap"})
        result = {k: v for k, v in result.items() if k != "cmap"}
    else:
        result = compare_scales(load_outlines(args.first), load_outlines(args.second))
        if args.out:
            write_json(args.out, result)
    print(json.dumps({k: v for k, v in result.items() if k != "cmap"}, ensure_ascii=False))


if __name__ == "__main__":
    main()
