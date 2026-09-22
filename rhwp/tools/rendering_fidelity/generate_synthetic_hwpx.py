#!/usr/bin/env python3
"""Build the ten deterministic HWPX rendering-fidelity probes."""

from __future__ import annotations

import hashlib
import json
import re
import struct
import zlib
import zipfile
import xml.etree.ElementTree as ET
from html import escape
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
SOURCE = ROOT / "samples" / "hwpx" / "ref" / "ref_empty.hwpx"
OUTPUT = ROOT / "samples" / "rendering-fidelity"
MANIFEST = Path(__file__).with_name("synthetic_manifest.json")
ZIP_TIME = (1980, 1, 1, 0, 0, 0)
NS = (
    'xmlns:ha="http://www.hancom.co.kr/hwpml/2011/app" '
    'xmlns:hp="http://www.hancom.co.kr/hwpml/2011/paragraph" '
    'xmlns:hp10="http://www.hancom.co.kr/hwpml/2016/paragraph" '
    'xmlns:hs="http://www.hancom.co.kr/hwpml/2011/section" '
    'xmlns:hc="http://www.hancom.co.kr/hwpml/2011/core" '
    'xmlns:hh="http://www.hancom.co.kr/hwpml/2011/head" '
    'xmlns:hhs="http://www.hancom.co.kr/hwpml/2011/history" '
    'xmlns:hm="http://www.hancom.co.kr/hwpml/2011/master-page" '
    'xmlns:hpf="http://www.hancom.co.kr/schema/2011/hpf" '
    'xmlns:dc="http://purl.org/dc/elements/1.1/" '
    'xmlns:opf="http://www.idpf.org/2007/opf/" '
    'xmlns:ooxmlchart="http://www.hancom.co.kr/hwpml/2016/ooxmlchart" '
    'xmlns:epub="http://www.idpf.org/2007/ops" '
    'xmlns:config="urn:oasis:names:tc:opendocument:xmlns:config:1.0"'
)


def zip_info(name: str, compression: int) -> zipfile.ZipInfo:
    info = zipfile.ZipInfo(name, ZIP_TIME)
    info.compress_type = compression
    info.external_attr = 0o100644 << 16
    return info


def append_items(xml: str, tag: str, items: list[str]) -> str:
    pattern = rf'<hh:{tag} itemCnt="(\d+)">'
    match = re.search(pattern, xml)
    if not match:
        raise RuntimeError(f"missing {tag}")
    count = int(match.group(1)) + len(items)
    xml = xml[: match.start()] + re.sub(pattern, f'<hh:{tag} itemCnt="{count}">', xml[match.start():], count=1)
    return xml.replace(f"</hh:{tag}>", "".join(items) + f"</hh:{tag}>", 1)


def border_fill(item_id: int, line: str, width: str, color: str = "#000000", fill: str | None = None) -> str:
    fill_xml = ""
    if fill:
        fill_xml = f'<hc:fillBrush><hc:winBrush faceColor="{fill}" hatchColor="#000000" alpha="0"/></hc:fillBrush>'
    edges = "".join(f'<hh:{side}Border type="{line}" width="{width}" color="{color}"/>' for side in ("left", "right", "top", "bottom"))
    return (
        f'<hh:borderFill id="{item_id}" threeD="0" shadow="0" centerLine="NONE" breakCellSeparateLine="0">'
        '<hh:slash type="NONE" Crooked="0" isCounter="0"/><hh:backSlash type="NONE" Crooked="0" isCounter="0"/>'
        f'{edges}<hh:diagonal type="SOLID" width="0.1 mm" color="#000000"/>{fill_xml}</hh:borderFill>'
    )


def char_pr(item_id: int, *, kerning: int = 0, spacing: int = 0, ratio: int = 100,
            color: str = "#000000", decorated: bool = False) -> str:
    decoration = ""
    if decorated:
        decoration = (
            '<hh:underline type="BOTTOM" shape="DASH" color="#C00000"/>'
            '<hh:strikeout shape="DASH_DOT" color="#0070C0"/><hh:outline type="SOLID"/>'
        )
    return (
        f'<hh:charPr id="{item_id}" height="1200" textColor="{color}" shadeColor="none" '
        f'useFontSpace="0" useKerning="{kerning}" symMark="NONE" borderFillIDRef="2">'
        '<hh:fontRef hangul="0" latin="0" hanja="0" japanese="0" other="0" symbol="0" user="0"/>'
        f'<hh:ratio hangul="{ratio}" latin="{ratio}" hanja="{ratio}" japanese="{ratio}" other="{ratio}" symbol="{ratio}" user="{ratio}"/>'
        f'<hh:spacing hangul="{spacing}" latin="{spacing}" hanja="{spacing}" japanese="{spacing}" other="{spacing}" symbol="{spacing}" user="{spacing}"/>'
        '<hh:relSz hangul="100" latin="100" hanja="100" japanese="100" other="100" symbol="100" user="100"/>'
        '<hh:offset hangul="0" latin="0" hanja="0" japanese="0" other="0" symbol="0" user="0"/>'
        f'{decoration}</hh:charPr>'
    )


def para_pr(item_id: int, *, spacing_type: str = "PERCENT", spacing: int = 160,
            tab_ref: int = 0, auto_eng: int = 0, auto_num: int = 0) -> str:
    return (
        f'<hh:paraPr id="{item_id}" tabPrIDRef="{tab_ref}" condense="0" fontLineHeight="0" snapToGrid="1" '
        'suppressLineNumbers="0" checked="0"><hh:align horizontal="LEFT" vertical="BASELINE"/>'
        '<hh:heading type="NONE" idRef="0" level="0"/><hh:breakSetting breakLatinWord="KEEP_WORD" '
        'breakNonLatinWord="BREAK_WORD" widowOrphan="0" keepWithNext="0" keepLines="0" '
        'pageBreakBefore="0" lineWrap="BREAK"/>'
        f'<hh:autoSpacing eAsianEng="{auto_eng}" eAsianNum="{auto_num}"/><hh:margin>'
        '<hc:intent value="0" unit="HWPUNIT"/><hc:left value="0" unit="HWPUNIT"/>'
        '<hc:right value="0" unit="HWPUNIT"/><hc:prev value="0" unit="HWPUNIT"/>'
        '<hc:next value="0" unit="HWPUNIT"/></hh:margin>'
        f'<hh:lineSpacing type="{spacing_type}" value="{spacing}" unit="HWPUNIT"/>'
        '<hh:border borderFillIDRef="2" offsetLeft="0" offsetRight="0" offsetTop="0" '
        'offsetBottom="0" connect="0" ignoreMargin="0"/></hh:paraPr>'
    )


def patched_header(raw: bytes) -> bytes:
    xml = raw.decode("utf-8")
    xml = append_items(xml, "borderFills", [
        border_fill(3, "SOLID", "0.12 mm"), border_fill(4, "DASH", "0.4 mm", "#C00000"),
        border_fill(5, "DOT", "0.4 mm", "#0070C0"), border_fill(6, "DASH_DOT", "0.5 mm", "#7030A0"),
        border_fill(7, "WAVE", "0.5 mm", "#008000"), border_fill(8, "DOUBLEWAVE", "0.5 mm"),
        border_fill(9, "DOUBLE_SLIM", "0.5 mm", fill="#FFF2CC"), border_fill(10, "SOLID", "1.0 mm", fill="#DDEBF7"),
    ])
    xml = append_items(xml, "charProperties", [
        char_pr(7), char_pr(8, kerning=1), char_pr(9, spacing=10), char_pr(10, spacing=-10),
        char_pr(11, ratio=80), char_pr(12, decorated=True), char_pr(13, color="#FFFFFF"),
    ])
    xml = append_items(xml, "paraProperties", [
        para_pr(20, spacing=100), para_pr(21, spacing=160), para_pr(22, spacing_type="FIXED", spacing=1800),
        para_pr(23, spacing_type="AT_LEAST", spacing=1800), para_pr(24, spacing_type="BETWEEN_LINES", spacing=600),
        para_pr(25, spacing=160, tab_ref=3), para_pr(26, spacing=160, auto_eng=1, auto_num=1),
    ])
    tab = (
        '<hh:tabPr id="3" autoTabLeft="0" autoTabRight="0">'
        '<hh:tabItem pos="8000" type="LEFT" leader="DOT"/>'
        '<hh:tabItem pos="22000" type="CENTER" leader="DASH"/>'
        '<hh:tabItem pos="40000" type="RIGHT" leader="SOLID"/></hh:tabPr>'
    )
    xml = xml.replace('<hh:tabProperties itemCnt="3">', '<hh:tabProperties itemCnt="4">', 1)
    xml = xml.replace('</hh:tabProperties>', tab + '</hh:tabProperties>', 1)
    return xml.encode("utf-8")


SEC_PR = (
    '<hp:secPr id="" textDirection="HORIZONTAL" spaceColumns="1134" tabStop="8000" outlineShapeIDRef="1" '
    'memoShapeIDRef="0" textVerticalWidthHead="0" masterPageCnt="0"><hp:grid lineGrid="0" charGrid="0" '
    'wonggojiFormat="0"/><hp:startNum pageStartsOn="BOTH" page="0" pic="0" tbl="0" equation="0"/>'
    '<hp:visibility hideFirstHeader="0" hideFirstFooter="0" hideFirstMasterPage="0" border="SHOW_ALL" fill="SHOW_ALL" '
    'hideFirstPageNum="0" hideFirstEmptyLine="0" showLineNumber="0"/><hp:lineNumberShape restartType="0" countBy="0" '
    'distance="0" startNumber="0"/><hp:pagePr landscape="WIDELY" width="59528" height="84186" gutterType="LEFT_ONLY">'
    '<hp:margin header="4252" footer="4252" gutter="0" left="8504" right="8504" top="5668" bottom="4252"/></hp:pagePr>'
    '<hp:footNotePr><hp:autoNumFormat type="DIGIT" userChar="" prefixChar="" suffixChar=")" supscript="0"/>'
    '<hp:noteLine length="-1" type="SOLID" width="0.12 mm" color="#000000"/><hp:noteSpacing betweenNotes="283" '
    'belowLine="567" aboveLine="850"/><hp:numbering type="CONTINUOUS" newNum="1"/><hp:placement place="EACH_COLUMN" '
    'beneathText="0"/></hp:footNotePr><hp:endNotePr><hp:autoNumFormat type="DIGIT" userChar="" prefixChar="" suffixChar=")" '
    'supscript="0"/><hp:noteLine length="14692" type="SOLID" width="0.12 mm" color="#000000"/>'
    '<hp:noteSpacing betweenNotes="0" belowLine="567" aboveLine="850"/><hp:numbering type="CONTINUOUS" newNum="1"/>'
    '<hp:placement place="END_OF_DOCUMENT" beneathText="0"/></hp:endNotePr><hp:pageBorderFill type="BOTH" borderFillIDRef="1" '
    'textBorder="PAPER" headerInside="0" footerInside="0" fillArea="PAPER"><hp:offset left="1417" right="1417" top="1417" '
    'bottom="1417"/></hp:pageBorderFill></hp:secPr><hp:ctrl><hp:colPr id="" type="NEWSPAPER" layout="LEFT" colCount="1" '
    'sameSz="1" sameGap="0"/></hp:ctrl>'
)


def line_seg(textpos: int = 0, height: int = 1400, y: int = 0) -> str:
    return (f'<hp:linesegarray><hp:lineseg textpos="{textpos}" vertpos="{y}" vertsize="{height}" textheight="{height}" '
            f'baseline="{int(height * .85)}" spacing="600" horzpos="0" horzsize="42520" flags="393216"/></hp:linesegarray>')


def paragraph(text: str = "", *, char: int = 7, para: int = 20, raw: bool = False,
              controls: str = "", first: bool = False, height: int = 1400,
              suffix: str = "", page_break: bool = False) -> str:
    body = text if raw else escape(text).replace("\n", "<hp:lineBreak/>")
    prefix = SEC_PR if first else ""
    return (f'<hp:p id="0" paraPrIDRef="{para}" styleIDRef="0" pageBreak="{int(page_break)}" columnBreak="0" merged="0">'
            f'<hp:run charPrIDRef="{char}">{prefix}<hp:t>{body}</hp:t>{controls}'
            f'{"<hp:t>" + escape(suffix) + "</hp:t>" if suffix else ""}</hp:run>'
            f'{line_seg(height=height) if first else ""}</hp:p>')


def cell(text: str, col: int, row: int, *, width: int, height: int = 4000, border: int = 3,
         col_span: int = 1, row_span: int = 1, margin: tuple[int, int, int, int] = (200, 200, 200, 200),
         valign: str = "CENTER", nested: str = "") -> str:
    left, right, top, bottom = margin
    content = paragraph(text, char=7, para=20, controls=nested, height=1200)
    return (
        f'<hp:tc name="" header="0" hasMargin="1" protect="0" editable="0" dirty="0" borderFillIDRef="{border}">'
        f'<hp:subList id="" textDirection="HORIZONTAL" lineWrap="BREAK" vertAlign="{valign}" linkListIDRef="0" '
        f'linkListNextIDRef="0" textWidth="0" textHeight="0" hasTextRef="0" hasNumRef="0">{content}</hp:subList>'
        f'<hp:cellAddr colAddr="{col}" rowAddr="{row}"/><hp:cellSpan colSpan="{col_span}" rowSpan="{row_span}"/>'
        f'<hp:cellSz width="{width}" height="{height}"/><hp:cellMargin left="{left}" right="{right}" top="{top}" bottom="{bottom}"/></hp:tc>'
    )


def table(rows: list[list[str]], *, width: int = 40000, cols: int | None = None, table_id: int = 1) -> str:
    col_count = cols or max(len(row) for row in rows)
    row_xml = "".join("<hp:tr>" + "".join(row) + "</hp:tr>" for row in rows)
    hp = "{http://www.hancom.co.kr/hwpml/2011/paragraph}"
    cells = [ET.fromstring(f"<root {NS}>{xml}</root>")[0] for row in rows for xml in row]
    heights = [0] * len(rows)
    for node in cells:
        row = int(node.find(f"{hp}cellAddr").get("rowAddr"))
        span = int(node.find(f"{hp}cellSpan").get("rowSpan"))
        height = int(node.find(f"{hp}cellSz").get("height"))
        if span == 1:
            heights[row] = max(heights[row], height)
    for node in cells:
        row = int(node.find(f"{hp}cellAddr").get("rowAddr"))
        span = int(node.find(f"{hp}cellSpan").get("rowSpan"))
        height = int(node.find(f"{hp}cellSz").get("height"))
        heights[row + span - 1] += max(0, height - sum(heights[row:row + span]))
    table_height = sum(heights)
    return (
        f'<hp:tbl id="{table_id}" zOrder="0" numberingType="TABLE" textWrap="TOP_AND_BOTTOM" textFlow="BOTH_SIDES" '
        f'lock="0" dropcapstyle="None" pageBreak="CELL" repeatHeader="0" rowCnt="{len(rows)}" colCnt="{col_count}" '
        'cellSpacing="0" borderFillIDRef="3" noAdjust="0"><hp:sz '
        f'width="{width}" widthRelTo="ABSOLUTE" height="{table_height}" heightRelTo="ABSOLUTE" protect="0"/>'
        '<hp:pos treatAsChar="1" affectLSpacing="0" flowWithText="1" allowOverlap="0" holdAnchorAndSO="0" '
        'vertRelTo="PARA" horzRelTo="PARA" vertAlign="TOP" horzAlign="LEFT" vertOffset="0" horzOffset="0"/>'
        '<hp:outMargin left="0" right="0" top="0" bottom="0"/>'
        f'<hp:inMargin left="0" right="0" top="0" bottom="0"/>{row_xml}</hp:tbl>'
    )


def line_shape(style: str, y: int, width: int, color: str, z: int) -> str:
    return (
        f'<hp:line id="{100 + z}" zOrder="{z}" numberingType="PICTURE" textWrap="IN_FRONT_OF_TEXT" textFlow="BOTH_SIDES" '
        'lock="0" dropcapstyle="None" href="" groupLevel="0" instid="0" isReverseHV="0"><hp:offset x="0" y="0"/>'
        '<hp:orgSz width="100" height="0"/><hp:curSz width="34000" height="0"/><hp:flip horizontal="0" vertical="0"/>'
        '<hp:rotationInfo angle="0" centerX="17000" centerY="0" rotateimage="1"/><hp:renderingInfo>'
        '<hc:transMatrix e1="1" e2="0" e3="0" e4="0" e5="1" e6="0"/><hc:scaMatrix e1="340" e2="0" e3="0" e4="0" e5="1" e6="0"/>'
        '<hc:rotMatrix e1="1" e2="0" e3="0" e4="0" e5="1" e6="0"/></hp:renderingInfo>'
        f'<hp:lineShape color="{color}" width="{width}" style="{style}" endCap="FLAT" headStyle="NORMAL" tailStyle="NORMAL" '
        'headfill="1" tailfill="1" headSz="SMALL_SMALL" tailSz="SMALL_SMALL" outlineStyle="NORMAL" alpha="0"/>'
        '<hp:shadow type="NONE" color="#000000" offsetX="0" offsetY="0" alpha="0"/><hp:startPt x="0" y="0"/><hp:endPt x="100" y="0"/>'
        '<hp:sz width="34000" widthRelTo="ABSOLUTE" height="0" heightRelTo="ABSOLUTE" protect="0"/>'
        f'<hp:pos treatAsChar="0" affectLSpacing="0" flowWithText="1" allowOverlap="1" holdAnchorAndSO="0" vertRelTo="PARA" '
        f'horzRelTo="PARA" vertAlign="TOP" horzAlign="LEFT" vertOffset="{y}" horzOffset="3500"/>'
        '<hp:outMargin left="0" right="0" top="0" bottom="0"/></hp:line>'
    )


def picture(image_id: str, *, width: int, height: int, clip: tuple[int, int, int, int], treat_as_char: int,
            wrap: str, x: int = 0, y: int = 0, z: int = 0, overlap: int = 0) -> str:
    left, right, top, bottom = clip
    return (
        f'<hp:pic id="{200 + z}" zOrder="{z}" numberingType="PICTURE" textWrap="{wrap}" textFlow="BOTH_SIDES" lock="0" '
        'dropcapstyle="None" href="" groupLevel="0" instid="0" reverse="0"><hp:offset x="0" y="0"/>'
        f'<hp:orgSz width="24000" height="12000"/><hp:curSz width="{width}" height="{height}"/><hp:flip horizontal="0" vertical="0"/>'
        f'<hp:rotationInfo angle="0" centerX="{width // 2}" centerY="{height // 2}" rotateimage="1"/><hp:renderingInfo>'
        f'<hc:transMatrix e1="1" e2="0" e3="0" e4="0" e5="1" e6="0"/><hc:scaMatrix e1="{width / 24000:.9f}" e2="0" e3="0" e4="0" e5="{height / 12000:.9f}" e6="0"/>'
        '<hc:rotMatrix e1="1" e2="0" e3="0" e4="0" e5="1" e6="0"/></hp:renderingInfo><hp:imgRect>'
        '<hc:pt0 x="0" y="0"/><hc:pt1 x="24000" y="0"/><hc:pt2 x="24000" y="12000"/><hc:pt3 x="0" y="12000"/>'
        f'</hp:imgRect><hp:imgClip left="{left}" right="{right}" top="{top}" bottom="{bottom}"/>'
        f'<hp:inMargin left="0" right="0" top="0" bottom="0"/><hp:imgDim dimwidth="24000" dimheight="12000"/>'
        f'<hc:img binaryItemIDRef="{image_id}" bright="0" contrast="0" effect="REAL_PIC" alpha="0"/><hp:effects/>'
        f'<hp:sz width="{width}" widthRelTo="ABSOLUTE" height="{height}" heightRelTo="ABSOLUTE" protect="0"/>'
        f'<hp:pos treatAsChar="{treat_as_char}" affectLSpacing="0" flowWithText="1" allowOverlap="{overlap}" holdAnchorAndSO="0" '
        f'vertRelTo="PARA" horzRelTo="PARA" vertAlign="TOP" horzAlign="LEFT" vertOffset="{y}" horzOffset="{x}"/>'
        '<hp:outMargin left="400" right="400" top="300" bottom="300"/></hp:pic>'
    )


def section(paragraphs: list[str]) -> bytes:
    return (f'<?xml version="1.0" encoding="UTF-8" standalone="yes"?><hs:sec {NS}>' + "".join(paragraphs) + '</hs:sec>').encode("utf-8")


def png(width: int, height: int, pixel) -> bytes:
    raw = bytearray()
    for y in range(height):
        raw.append(0)
        for x in range(width):
            raw.extend(pixel(x, y))
    def chunk(kind: bytes, data: bytes) -> bytes:
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF)
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(bytes(raw), 9)) + chunk(b"IEND", b"")


IMAGES = {
    "fidelity-grid.png": png(240, 120, lambda x, y: ((x // 30) * 30, (y // 20) * 38, 180, 255)),
    "fidelity-red.png": png(160, 100, lambda x, y: (220, 40, 40, 180 if 8 < x < 152 and 8 < y < 92 else 0)),
    "fidelity-blue.png": png(160, 100, lambda x, y: (40, 90, 220, 180 if (x - 80) ** 2 + (y - 50) ** 2 < 2200 else 0)),
}


def fixture_specs() -> list[dict]:
    equal = 13000
    table1 = table([
        [cell("SOLID", 0, 0, width=equal, border=3), cell("DASH", 1, 0, width=equal, border=4), cell("DOT", 2, 0, width=equal, border=5)],
        [cell("DASH_DOT", 0, 1, width=equal, border=6), cell("WAVE", 1, 1, width=equal, border=7), cell("DOUBLE_WAVE", 2, 1, width=equal, border=8)],
        [cell("DOUBLE", 0, 2, width=equal, border=9), cell("thick shared edge", 1, 2, width=equal, border=10), cell("thin neighbor", 2, 2, width=equal, border=3)],
    ], width=39000, cols=3)
    table2 = table([
        [cell("row span\nTOP", 0, 0, width=13000, height=9000, border=10, row_span=2, margin=(900, 200, 900, 200), valign="TOP"),
         cell("merged two columns, wide left/right padding", 1, 0, width=26000, border=9, col_span=2, margin=(1400, 1400, 150, 150), valign="CENTER")],
        [cell("BOTTOM\nuneven padding", 1, 1, width=13000, border=4, margin=(100, 1000, 100, 700), valign="BOTTOM"),
         cell("CENTER", 2, 1, width=13000, border=5, margin=(700, 100, 500, 100), valign="CENTER")],
    ], width=39000, cols=3)
    inner = table([[cell("nested A", 0, 0, width=9000, height=3000, border=4), cell("nested B", 1, 0, width=9000, height=3000, border=7)]], width=18000, cols=2, table_id=2)
    table3 = table([[cell("outer left", 0, 0, width=18000, height=8000, border=3), cell("", 1, 0, width=21000, height=8000, border=9, nested=inner)]], width=39000, cols=2)
    lines = "".join(line_shape(style, 3500 + i * 2800, width, color, i + 1) for i, (style, width, color) in enumerate([
        ("SOLID", 80, "#000000"), ("DASH", 120, "#C00000"), ("DOT", 120, "#0070C0"),
        ("DASH_DOT", 140, "#7030A0"), ("LONG_DASH", 180, "#008000"), ("WAVE", 140, "#000000"),
    ]))
    inline = picture("fidelity-grid", width=12000, height=6000, clip=(6000, 18000, 2000, 10000), treat_as_char=1, wrap="TOP_AND_BOTTOM")
    square_left = picture("fidelity-grid", width=12000, height=6000, clip=(0, 24000, 0, 12000), treat_as_char=0, wrap="SQUARE", x=0, y=1200, z=1)
    square_right = picture("fidelity-grid", width=10000, height=7000, clip=(3000, 21000, 0, 12000), treat_as_char=0, wrap="SQUARE", x=30000, y=9000, z=2)
    red = picture("fidelity-red", width=18000, height=11000, clip=(0, 24000, 0, 12000), treat_as_char=0, wrap="BEHIND_TEXT", x=7000, y=2500, z=1, overlap=1)
    blue = picture("fidelity-blue", width=18000, height=11000, clip=(0, 24000, 0, 12000), treat_as_char=0, wrap="IN_FRONT_OF_TEXT", x=16000, y=7000, z=4, overlap=1)
    return [
        {"file": "01-table-border-styles.hwpx", "title": "Table borders and shared-edge precedence", "features": ["solid, dash, dot, dash-dot, wave, double-wave and double borders", "adjacent cells with conflicting edge widths and colors"], "paragraphs": [paragraph("01 TABLE BORDER STYLES", first=True), paragraph(controls=table1, height=13000)]},
        {"file": "02-table-merged-padding-valign.hwpx", "title": "Merged cells, padding and vertical alignment", "features": ["row and column spans", "asymmetric cell padding", "top, center and bottom alignment"], "paragraphs": [paragraph("02 MERGED CELLS / PADDING / VALIGN", first=True), paragraph(controls=table2, height=11000)]},
        {"file": "03-table-nested.hwpx", "title": "Nested table geometry", "features": ["inline table nested inside a cell", "outer and inner border interaction", "cell content height propagation"], "paragraphs": [paragraph("03 NESTED TABLE", first=True), paragraph(controls=table3, height=10000)]},
        {"file": "04-latin-kerning-spacing.hwpx", "title": "Latin kerning and character spacing", "features": ["kerning off and on", "positive and negative tracking", "80 percent horizontal ratio"], "paragraphs": [paragraph("04 LATIN KERNING / TRACKING", first=True), paragraph("AVATAR WA To Ty fi ffi office 012345", char=7), paragraph("AVATAR WA To Ty fi ffi office 012345", char=8), paragraph("AVATAR WA To Ty fi ffi office 012345", char=9), paragraph("AVATAR WA To Ty fi ffi office 012345", char=10), paragraph("AVATAR WA To Ty fi ffi office 012345", char=11)]},
        {"file": "05-mixed-korean-latin.hwpx", "title": "Mixed Korean, Latin and number spacing", "features": ["Korean/Latin boundaries", "Korean/number auto-spacing", "punctuation, currency and narrow width wrapping"], "paragraphs": [paragraph("05 MIXED SCRIPT SPACING", first=True), paragraph("한글ABC한글 2026년OpenAI문서 가격₩12,345.67 (Test) 가나다라마바사아자차카타파하", para=20), paragraph("한글ABC한글 2026년OpenAI문서 가격₩12,345.67 (Test) 가나다라마바사아자차카타파하", para=26), paragraph("LongTokenWithoutSpaces-ABCDEFGHIJKLMNOPQRSTUVWXYZ-0123456789 한글혼합줄바꿈검사", char=11, para=26)]},
        {"file": "06-lines-literal-decorated.hwpx", "title": "Literal text decoration and drawn line styles", "features": ["literal underscore, hyphen and box-drawing glyphs", "underline, strikeout and outline decoration", "drawn solid, dashed, dotted, dash-dot, long-dash and wave lines"], "paragraphs": [paragraph("06 LITERAL AND DRAWN LINES", first=True, controls=lines, height=22000), paragraph("____ ---- ==== ···· ──── ┄┄┄┄ ~~~~", char=7), paragraph("Decorated text / 밑줄과 취소선", char=12)]},
        {"file": "07-image-inline-crop.hwpx", "title": "Inline image baseline and crop", "features": ["as-character image in mixed text", "source crop rectangle", "line height expansion around inline image"], "images": ["fidelity-grid"], "paragraphs": [paragraph("07 INLINE IMAGE AND CROP", first=True), paragraph("Before [", controls=inline, suffix="] after inline image. 다음 줄 baseline check.")]},
        {"file": "08-image-square-wrapping.hwpx", "title": "Floating image square wrapping", "features": ["left and right floating anchors", "square wrap exclusion", "cropped floating image with object margins", "paragraph-end float anchors"], "images": ["fidelity-grid"], "paragraphs": [paragraph("08 SQUARE WRAP LEFT / RIGHT", first=True), paragraph(controls=square_left + square_right, suffix="This long paragraph surrounds two floating pictures. 이미지 주변으로 영문과 한글이 함께 흐를 때 줄 시작점, 줄 끝점, 개체 바깥 여백을 비교합니다. The quick brown fox jumps over the lazy dog while numbers 0123456789 continue across several lines. 같은 문장을 반복하여 양쪽 감싸기 경계를 확인합니다. This long paragraph surrounds two floating pictures. " * 2), paragraph("08 PICTURES ANCHORED AFTER TEXT", page_break=True), paragraph("This long paragraph surrounds two floating pictures. 이미지 주변으로 영문과 한글이 함께 흐를 때 줄 시작점, 줄 끝점, 개체 바깥 여백을 비교합니다. The quick brown fox jumps over the lazy dog while numbers 0123456789 continue across several lines. 같은 문장을 반복하여 양쪽 감싸기 경계를 확인합니다. This long paragraph surrounds two floating pictures. " * 2, controls=square_left.replace('id="201"', 'id="203"') + square_right.replace('id="202"', 'id="204"'))]},
        {"file": "09-image-layer-order.hwpx", "title": "Image layer order and text overlap", "features": ["transparent PNG alpha", "behind-text and in-front-of-text layers", "overlapping objects with distinct z-order"], "images": ["fidelity-red", "fidelity-blue"], "paragraphs": [paragraph("09 LAYER ORDER", first=True), paragraph("\n".join(f"Layer {i:02d}: RED behind text / BLUE above text / 한글" for i in range(1, 17)), controls=red + blue)]},
        {"file": "10-paragraph-tabs-line-spacing.hwpx", "title": "Tab leaders and paragraph line spacing", "features": ["left, center and right tab stops with leaders", "100 and 160 percent spacing", "fixed, at-least and between-lines spacing"], "paragraphs": [paragraph("10 TABS AND LINE SPACING", first=True), paragraph('LEFT<hp:tab width="8000" leader="1" type="0"/>CENTER<hp:tab width="14000" leader="2" type="1"/>RIGHT<hp:tab width="18000" leader="3" type="2"/>END', para=25, raw=True), paragraph("100% line one\n100% line two", para=20), paragraph("160% line one\n160% line two", para=21), paragraph("FIXED 1800 line one\nFIXED 1800 line two", para=22), paragraph("AT LEAST 1800 line one\nAT LEAST 1800 line two", para=23), paragraph("BETWEEN LINES 600 line one\nBETWEEN LINES 600 line two", para=24)]},
    ]


def add_images(entries: dict[str, bytes], ids: list[str]) -> None:
    if not ids:
        return
    content = entries["Contents/content.hpf"].decode("utf-8")
    items = []
    for image_id in ids:
        filename = f"{image_id}.png"
        entries[f"BinData/{filename}"] = IMAGES[filename]
        items.append(f'<opf:item id="{image_id}" href="BinData/{filename}" media-type="image/png" isEmbeded="1"/>')
    entries["Contents/content.hpf"] = content.replace("</opf:manifest>", "".join(items) + "</opf:manifest>", 1).encode("utf-8")


def write_fixture(base: dict[str, bytes], spec: dict) -> str:
    entries = dict(base)
    entries["Contents/header.xml"] = patched_header(entries["Contents/header.xml"])
    entries["Contents/section0.xml"] = section(spec["paragraphs"])
    add_images(entries, spec.get("images", []))
    target = OUTPUT / spec["file"]
    with zipfile.ZipFile(target, "w") as archive:
        for name, data in entries.items():
            compression = zipfile.ZIP_STORED if name == "mimetype" else zipfile.ZIP_DEFLATED
            archive.writestr(zip_info(name, compression), data)
    return hashlib.sha256(target.read_bytes()).hexdigest()


def main() -> int:
    OUTPUT.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(SOURCE) as source:
        base = {name: source.read(name) for name in source.namelist()}
    specs = fixture_specs()
    if len(specs) != 10:
        raise RuntimeError("the corpus must contain exactly ten fixtures")
    manifest = {"schema_version": 1, "generator": "generate_synthetic_hwpx.py", "source": str(SOURCE.relative_to(ROOT)), "documents": []}
    for spec in specs:
        digest = write_fixture(base, spec)
        manifest["documents"].append({key: spec[key] for key in ("file", "title", "features")} | {"sha256": digest})
        print(f"{spec['file']}  {digest}")
    MANIFEST.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
