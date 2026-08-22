#!/usr/bin/env python3
"""Rauhwpx 공문/품의 HWPX 서식을 기존 기안문 씨앗에서 결정적으로 만든다."""
from __future__ import annotations

import io
import os
import re
import shutil
import sys
import tempfile
import zipfile

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")

BASE = os.path.dirname(os.path.abspath(__file__))
SEED_GONGMUN = os.path.join(BASE, "..", "tools", "forms", "일반기안문_서식.hwpx")
SEED_PUMUI = os.path.join(BASE, "..", "tools", "forms", "간이기안문_서식.hwpx")
OUT_GONGMUN = os.path.join(BASE, "공문.hwpx")
OUT_PUMUI = os.path.join(BASE, "품의.hwpx")

PACK_ID = "rauhwpx-office"
PACK_MARKER = "META-INF/rauhwpx-form-pack"
BRAND_GONGMUN = "Rauhwpx 공문 서식"
BRAND_PUMUI = "Rauhwpx 품의 서식"


def unzip_seed(seed: str, dest: str) -> None:
    with zipfile.ZipFile(seed) as z:
        z.extractall(dest)


def write_hwpx(src_dir: str, out_path: str) -> None:
    if os.path.exists(out_path):
        os.remove(out_path)
    with zipfile.ZipFile(out_path, "w") as z:
        z.write(os.path.join(src_dir, "mimetype"), "mimetype", compress_type=zipfile.ZIP_STORED)
        for root, _, files in os.walk(src_dir):
            for name in files:
                full = os.path.join(root, name)
                rel = os.path.relpath(full, src_dir).replace("\\", "/")
                if rel == "mimetype":
                    continue
                compress = zipfile.ZIP_STORED if rel == PACK_MARKER else zipfile.ZIP_DEFLATED
                z.write(full, rel, compress_type=compress)


FID = [2_100_000_000]
PID = [400]
TID = [2_000_000_000]


def reset_ids() -> None:
    FID[0] = 2_100_000_000
    PID[0] = 400
    TID[0] = 2_000_000_000


def field(name: str, guide: str) -> str:
    FID[0] += 1
    return (
        f'<hp:ctrl><hp:fieldBegin id="{FID[0]}" type="CLICK_HERE" name="{name}" editable="1">'
        f'<hp:parameters cnt="1" name=""><hp:stringParam name="Command">'
        f"Clickhere:set:48:Direction:wstring:{len(guide)}:{guide} HelpState:wstring:0:  "
        f"</hp:stringParam></hp:parameters>"
        f'</hp:fieldBegin></hp:ctrl><hp:ctrl><hp:fieldEnd beginIDRef="{FID[0]}"/></hp:ctrl>'
    )


def para(inner: str, ppr: int = 0, cpr: int = 0) -> str:
    PID[0] += 1
    return (
        f'<hp:p id="{PID[0]}" paraPrIDRef="{ppr}" styleIDRef="0" pageBreak="0" '
        f'columnBreak="0" merged="0"><hp:run charPrIDRef="{cpr}">{inner}</hp:run></hp:p>'
    )


def t(text: str) -> str:
    return f"<hp:t>{text}</hp:t>"


def cell(
    inner: str,
    col: int,
    row: int,
    width: int,
    height: int,
    colspan: int = 1,
    rowspan: int = 1,
    cpr: int = 3,
    ppr: int = 0,
    bfid: int = 3,
) -> str:
    return (
        f'<hp:tc name="" header="0" hasMargin="0" protect="0" editable="0" dirty="0" '
        f'borderFillIDRef="{bfid}">'
        f'<hp:subList id="" textDirection="HORIZONTAL" lineWrap="BREAK" vertAlign="CENTER" '
        f'linkListIDRef="0" linkListNextIDRef="0" textWidth="0" textHeight="0" hasTextRef="0" '
        f'hasNumRef="0">'
        f'<hp:p id="0" paraPrIDRef="{ppr}" styleIDRef="0" pageBreak="0" columnBreak="0" merged="0">'
        f'<hp:run charPrIDRef="{cpr}">{inner}</hp:run></hp:p></hp:subList>'
        f'<hp:cellAddr colAddr="{col}" rowAddr="{row}"/>'
        f'<hp:cellSpan colSpan="{colspan}" rowSpan="{rowspan}"/>'
        f'<hp:cellSz width="{width}" height="{height}"/>'
        f'<hp:cellMargin left="141" right="141" top="141" bottom="141"/></hp:tc>'
    )


def table(
    rows_xml: str,
    rowcnt: int,
    colcnt: int,
    width: int,
    height: int,
    bfid: int = 3,
    wrap: str = "TOP_AND_BOTTOM",
) -> str:
    TID[0] += 1
    return (
        f'<hp:tbl id="{TID[0]}" zOrder="0" numberingType="TABLE" textWrap="{wrap}" '
        f'textFlow="BOTH_SIDES" lock="0" dropcapstyle="None" pageBreak="CELL" repeatHeader="0" '
        f'rowCnt="{rowcnt}" colCnt="{colcnt}" cellSpacing="0" borderFillIDRef="{bfid}" noAdjust="0">'
        f'<hp:sz width="{width}" widthRelTo="ABSOLUTE" height="{height}" heightRelTo="ABSOLUTE" '
        f'protect="0"/>'
        f'<hp:pos treatAsChar="1" affectLSpacing="0" flowWithText="1" allowOverlap="0" '
        f'holdAnchorAndSO="0" vertRelTo="PARA" horzRelTo="COLUMN" vertAlign="TOP" '
        f'horzAlign="LEFT" vertOffset="0" horzOffset="0"/>'
        f'<hp:outMargin left="0" right="0" top="0" bottom="0"/>'
        f'<hp:inMargin left="141" right="141" top="141" bottom="141"/>'
        f"{rows_xml}</hp:tbl>"
    )


def tr(cells: list[str]) -> str:
    return "<hp:tr>" + "".join(cells) + "</hp:tr>"


def stamp_pack_id(work: str) -> None:
    dest = os.path.join(work, "META-INF")
    os.makedirs(dest, exist_ok=True)
    open(os.path.join(dest, "rauhwpx-form-pack"), "w", encoding="utf-8", newline="\n").write(
        PACK_ID + "\n"
    )


def build_gongmun(work: str) -> None:
    section = os.path.join(work, "Contents", "section0.xml")
    xml = open(section, encoding="utf-8").read()
    brand = para(t(BRAND_GONGMUN), ppr=2, cpr=3)
    if "</hs:sec>" not in xml:
        raise SystemExit("공문 씨앗에 </hs:sec> 이 없습니다")
    xml = xml.replace("</hs:sec>", brand + "</hs:sec>")
    open(section, "w", encoding="utf-8", newline="").write(xml)
    preview = os.path.join(work, "Preview", "PrvText.txt")
    open(preview, "w", encoding="utf-8", newline="").write(BRAND_GONGMUN)


def build_pumui(work: str) -> None:
    reset_ids()
    section = os.path.join(work, "Contents", "section0.xml")
    xml = open(section, encoding="utf-8").read()
    first_p = re.search(r"<hp:p .*?</hp:p>", xml, flags=re.S)
    if not first_p:
        raise SystemExit("품의 씨앗에서 첫 문단을 찾지 못했습니다")
    prolog = xml[: xml.index(first_p.group(0))]
    first_clean = re.sub(r"<hp:t>.*?</hp:t>", "<hp:t></hp:t>", first_p.group(0), flags=re.S)

    info_rows = []
    for r, (lab, fname, guide) in enumerate(
        [
            ("생산등록번호", "생산등록번호", " "),
            ("등록일", "등록일", " "),
            ("공개구분", "공개구분", " "),
        ]
    ):
        info_rows.append(
            tr(
                [
                    cell(t(lab), 0, r, 7000, 1400),
                    cell(field(fname, guide), 1, r, 11000, 1400),
                ]
            )
        )
    info_tbl = table("".join(info_rows), 3, 2, 18000, 4200)

    app_rows = [
        tr(
            [
                cell(field("결재직위1", "직위"), 0, 0, 5000, 1400),
                cell(field("결재직위2", " "), 1, 0, 5000, 1400),
                cell(field("결재직위3", " "), 2, 0, 5000, 1400),
                cell(field("결재직위4", " "), 3, 0, 5000, 1400),
            ]
        ),
        tr(
            [
                cell(t(""), 0, 1, 5000, 3600),
                cell(t(""), 1, 1, 5000, 3600),
                cell(t(""), 2, 1, 5000, 3600),
                cell(t(""), 3, 1, 5000, 3600),
            ]
        ),
        tr(
            [
                cell(t("협조자"), 0, 2, 5000, 1400),
                cell(field("협조자", " "), 1, 2, 15000, 1400, colspan=3),
            ]
        ),
    ]
    app_tbl = table("".join(app_rows), 3, 4, 20000, 6400)

    # 바깥 표 한 칸에 문서정보·결재란 중첩 표를 넣는다. 채운 뒤에도 이 격자 크기는 그대로여야 한다.
    header_row = tr(
        [
            cell(info_tbl + t(""), 0, 0, 20000, 6800),
            cell(app_tbl + t(""), 1, 0, 22000, 6800),
        ]
    )
    title_row = tr([cell(field("제목", "(제        목)"), 0, 1, 42000, 4200, colspan=2, cpr=1, ppr=2)])
    body_row = tr([cell(field("본문", "품의 내용을 입력하세요"), 0, 2, 42000, 12000, colspan=2)])
    attach_row = tr(
        [
            cell(t("첨부  ") + field("첨부", "첨부 목록"), 0, 3, 42000, 2400, colspan=2),
        ]
    )
    outer = table("".join([header_row, title_row, body_row, attach_row]), 4, 2, 42000, 25400)

    body = [
        para(outer + t(""), ppr=0, cpr=3),
        para(t(""), ppr=0, cpr=0),
        para(
            t("기안자  ") + field("기안자", "직위 성명") + t("    부서  ") + field("부서", "부서명"),
            ppr=0,
            cpr=3,
        ),
        para(field("작성일", "작성일"), ppr=2, cpr=0),
        para(t(BRAND_PUMUI), ppr=2, cpr=3),
    ]
    open(section, "w", encoding="utf-8", newline="").write(
        prolog + first_clean + "".join(body) + "</hs:sec>"
    )
    open(os.path.join(work, "Preview", "PrvText.txt"), "w", encoding="utf-8", newline="").write(
        BRAND_PUMUI
    )


def main() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        gongmun_dir = os.path.join(tmp, "gongmun")
        pumui_dir = os.path.join(tmp, "pumui")
        unzip_seed(SEED_GONGMUN, gongmun_dir)
        unzip_seed(SEED_PUMUI, pumui_dir)
        build_gongmun(gongmun_dir)
        build_pumui(pumui_dir)
        stamp_pack_id(gongmun_dir)
        stamp_pack_id(pumui_dir)
        write_hwpx(gongmun_dir, OUT_GONGMUN)
        write_hwpx(pumui_dir, OUT_PUMUI)
    print("built:", OUT_GONGMUN, os.path.getsize(OUT_GONGMUN), "bytes")
    print("built:", OUT_PUMUI, os.path.getsize(OUT_PUMUI), "bytes")


if __name__ == "__main__":
    main()
