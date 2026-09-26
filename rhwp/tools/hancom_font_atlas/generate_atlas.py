#!/usr/bin/env python3
"""HFT 글리프 표본 HWPX와 기계 판독용 칸 목록을 만든다."""
from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import math
import sys
import zipfile
from pathlib import Path
from hft_inventory import HFT_DIR as DEFAULT_HFT_DIR, inventory

RHWP_ROOT = Path(__file__).resolve().parents[2]
SOURCE = RHWP_ROOT / 'samples/hwpx/ref/ref_empty.hwpx'
SYNTH = RHWP_ROOT / 'tools/rendering_fidelity/generate_synthetic_hwpx.py'
HFT_DIR = DEFAULT_HFT_DIR
OUT = Path.cwd()
synth = None


def configure(*, rhwp_root: Path, source_hwpx: Path, hft_dir: Path, out_dir: Path):
    global SOURCE, SYNTH, HFT_DIR, OUT, synth
    SOURCE = source_hwpx.resolve()
    SYNTH = (rhwp_root / 'tools/rendering_fidelity/generate_synthetic_hwpx.py').resolve()
    HFT_DIR = hft_dir.resolve()
    OUT = out_dir.resolve()
    if not SOURCE.is_file() or not SYNTH.is_file() or not HFT_DIR.is_dir():
        raise FileNotFoundError(f'원본 HWPX/생성 도우미/HFT 폴더 확인: {SOURCE}, {SYNTH}, {HFT_DIR}')
    OUT.mkdir(parents=True, exist_ok=True)
    spec = importlib.util.spec_from_file_location('rhwp_synthetic', SYNTH)
    synth = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(synth)

VALIDATION_PROFILES = {
    'dinaru': '신명 디나루', 'taegraphic': '신명 태그래픽',
    'taegothic': '신명 태고딕', 'semyungjo': '신명 세명조',
    'taemyungjo': '신명 태명조',
}


def sha(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def pilot_chars() -> list[str]:
    hangul = '가각간갈감갑값갓갔강개객거건검것게겨결경고곡공과관광구국권귀규그글금기김꽃나날남내너누눈뉴다달대덕도독동두둥드들등라락랑러로루리마말맑맘먹메모무문물미민바박반발밤방배백버범별보복볼봄부북분불비빛빠사산살삼상새색생서석선설섬성세소손솔송수순술스승시식신실심십아악안알암압앙애야어언얼엄업에여연열영예오온올옷와완왜요우운울움위유육으은을음의이인일임입자작잔잘잠잡장재저전절점정제조주준줄중즈지직진질짐집차착찬참창채처천철첨청초총추춘출충치카커코쿠큰타탁탄태터토통투특파판팔패퍼편평포표푸풀피하학한할함합항해허현혈형호홍화환활회효후훈휴흐희히'
    # 표본은 한글 일부와 ASCII 전체를 포함한다.
    sample = [hangul[i] for i in range(0, len(hangul), 5)][:25]
    return [' '] + list('0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz') + list('!?.,-+()[]:;/') + sample


def ks2350_chars() -> list[str]:
    chars=[]
    for hi in range(0xB0,0xC9):
        for lo in range(0xA1,0xFF):
            chars.append(bytes([hi,lo]).decode('euc_kr'))
    if len(chars)!=2350 or len(set(chars))!=2350:
        raise ValueError('KS X 1001 Hangul map is incomplete')
    return chars


def hanja4888_chars() -> list[str]:
    chars = [bytes([hi, lo]).decode('euc_kr')
             for hi in range(0xCA, 0xFE) for lo in range(0xA1, 0xFF)]
    if len(chars) != 4888 or len(set(chars)) != 4888:
        raise ValueError('KS X 1001 Hanja map is incomplete')
    return chars


def width_for(ch: str, latin_bank: dict, hangul_bank: dict | None,
              hanja_bank: dict | None, mapped_hangul: set[str],
              mapped_hanja: set[str]) -> int:
    if ch in mapped_hangul or ch in mapped_hanja:
        bank = hangul_bank if ch in mapped_hangul else hanja_bank
        if bank is None:
            raise ValueError(f'U+{ord(ch):04X} 원본 은행이 없습니다')
        data = Path(bank['path']).read_bytes()
        offset = bank['width_table_offset']+10
        return int.from_bytes(data[offset:offset+2],'little')
    if not 0x20 <= ord(ch) <= 0x7e:
        raise ValueError(f'unknown advance U+{ord(ch):04X}')
    data = Path(latin_bank['path']).read_bytes()
    offset = latin_bank['width_table_offset'] + 10 + (ord(ch)-0x20)*2
    return int.from_bytes(data[offset:offset+2], 'little')


def generate(family: str, chars: list[str], stem: str, *, cols=8, rows=12,
             font_size_pt=30, style='Regular', repeat=1, space_context='latin',
             italic_angle_deg=None, excluded_codepoints=None, excluded_reason=None,
             latin_bank_name=None, hangul_bank_name=None, hanja_bank_name=None):
    if synth is None:
        raise RuntimeError('configure()를 먼저 호출해야 합니다')
    families = inventory(HFT_DIR)['families']
    family = VALIDATION_PROFILES.get(family, family)
    if family not in families:
        raise ValueError(f'Font family is absent from HFT inventory: {family}')
    banks = families[family]
    overrides={'latin_hft_0x20_0x85':latin_bank_name,'latin_hft_ascii':latin_bank_name,
               'ks_x_1001_hangul_2350':hangul_bank_name,
               'ks_x_1001_hanja_4888':hanja_bank_name}
    if latin_bank_name and not any(b['filename']==latin_bank_name and b['encoding'].startswith('latin_hft_') for b in banks):
        raise ValueError(f'{family}: 선택한 Latin 은행이 없습니다: {latin_bank_name}')
    for encoding, name in [('ks_x_1001_hangul_2350',hangul_bank_name),
                           ('ks_x_1001_hanja_4888',hanja_bank_name)]:
        if name and not any(b['filename']==name and b['encoding']==encoding for b in banks):
            raise ValueError(f'{family}: 선택한 {encoding} 은행이 없습니다: {name}')
    by_encoding = {}
    for bank in banks:
        override=overrides.get(bank['encoding'])
        if override and bank['filename']!=override:
            continue
        if bank['encoding'] in by_encoding and bank['encoding'] in (
            'latin_hft_0x20_0x85','latin_hft_ascii','ks_x_1001_hangul_2350','ks_x_1001_hanja_4888'):
            prior=by_encoding[bank['encoding']]['filename']
            raise ValueError(f'{family}: {bank["encoding"]} 은행 {prior}, {bank["filename"]}이(가) 중복됩니다. 글꼴 스타일/은행 선택 규칙을 확인해야 합니다.')
        by_encoding[bank['encoding']] = bank
    latin_bank = by_encoding.get('latin_hft_0x20_0x85') or by_encoding.get('latin_hft_ascii')
    hangul_bank = by_encoding.get('ks_x_1001_hangul_2350')
    hanja_bank = by_encoding.get('ks_x_1001_hanja_4888')
    if not latin_bank:
        raise ValueError(f'No supported Latin HFT bank for {family}')
    if latin_bank['encoding'] != 'latin_hft_0x20_0x85':
        raise ValueError(f'{family}: Latin 은행 {latin_bank["filename"]}의 인코딩은 현재 변환기가 지원하지 않습니다')
    mapped_hangul = set(ks2350_chars()) if 'ks_x_1001_hangul_2350' in by_encoding else set()
    mapped_hanja = set(hanja4888_chars()) if 'ks_x_1001_hanja_4888' in by_encoding else set()
    for ch in chars:
        if not (0x20 <= ord(ch) <= 0x7e or ch in mapped_hangul or ch in mapped_hanja):
            raise ValueError(f'U+{ord(ch):04X} lacks a verified HFT source-bank mapping for {family}')
    selected_encodings = set()
    if any(0x20 <= ord(ch) <= 0x7e for ch in chars):
        selected_encodings.add(latin_bank['encoding'])
    if any(ch in mapped_hangul for ch in chars):
        selected_encodings.add('ks_x_1001_hangul_2350')
    if any(ch in mapped_hanja for ch in chars):
        selected_encodings.add('ks_x_1001_hanja_4888')
    selected_banks = [by_encoding[key] for key in sorted(selected_encodings)]
    selected_em={bank['design_units_per_em'] for bank in selected_banks}
    if None in selected_em or len(selected_em)!=1:
        raise ValueError(f'{family}: 선택한 은행의 디자인 em이 다르거나 검증되지 않아 현재 변환기로 묶을 수 없습니다')
    if style not in ('Regular', 'Bold', 'Italic', 'Bold Italic'):
        raise ValueError(f'Unsupported atlas style: {style}')
    with zipfile.ZipFile(SOURCE) as archive:
        entries = {name: archive.read(name) for name in archive.namelist()}
    header = entries['Contents/header.xml'].decode()
    header = header.replace('face="함초롬돋움" type="TTF"', f'face="{family}" type="HFT"')
    char = synth.char_pr(7).replace('height="1200"', f'height="{font_size_pt * 100}"')
    style_tags = ('<hh:bold/>' if 'Bold' in style else '') + ('<hh:italic/>' if 'Italic' in style else '')
    char = char.replace('</hh:charPr>', style_tags + '</hh:charPr>')
    header = synth.append_items(header, 'charProperties', [char])
    header = synth.append_items(header, 'paraProperties', [synth.para_pr(20, spacing=100)])
    entries['Contents/header.xml'] = header.encode()
    cell_w = 5315
    cell_h = 5000
    manifest_entries = []
    pages = math.ceil(len(chars)/(cols*rows))
    paragraphs = []
    for page in range(pages):
        slice_chars = chars[page*cols*rows:(page+1)*cols*rows]
        trs = []
        for row in range(rows):
            cells = []
            for col in range(cols):
                idx = row*cols+col
                glyph = slice_chars[idx] if idx < len(slice_chars) else ''
                space_probe = 'A A' if space_context == 'latin' else '가 가'
                cell_text = (space_probe if glyph == ' ' else glyph * repeat) if repeat == 2 else glyph
                cells.append(synth.cell(cell_text, col, row, width=cell_w, height=cell_h,
                                        border=1, margin=(500, 0, 0, 0), valign='TOP'))
                if glyph:
                    source_bank=(hangul_bank if glyph in mapped_hangul else
                                 hanja_bank if glyph in mapped_hanja else latin_bank)
                    if not source_bank or not source_bank.get('design_units_per_em'):
                        raise ValueError(f'U+{ord(glyph):04X} 원본 디자인 em을 검증할 수 없습니다')
                    advance=width_for(glyph,latin_bank,hangul_bank,hanja_bank,
                                      mapped_hangul,mapped_hanja)
                    x0 = 85.04 + col*cell_w/100
                    y0 = 56.68 + row*cell_h/100
                    manifest_entries.append({
                        'codepoint': f'U+{ord(glyph):04X}', 'char': glyph, 'page': page+1,
                        'row': row, 'col': col,
                        'cell_rect_pt': [x0, y0, x0+cell_w/100, y0+cell_h/100],
                        'origin_pt': [x0+5, y0+35], 'baseline_pt': y0+35,
                        'font_family': family, 'style': style, 'font_size_pt': font_size_pt,
                        'em_units': source_bank['design_units_per_em'],
                        'source_hft_bank': source_bank['filename'],
                        'source_hft_design_units_per_em': source_bank['design_units_per_em'],
                        'advance_units': advance,
                        'source_hft_advance_units': advance,
                        'expected_status': 'blank' if glyph == ' ' else 'ink'
                    })
            trs.append(cells)
        table = synth.table(trs, width=cell_w*cols, cols=cols, table_id=page+1)
        table = table.replace('borderFillIDRef="3"', 'borderFillIDRef="1"')
        paragraphs.append(synth.paragraph('', char=7, para=20, controls=table,
                                           first=(page==0), height=3000,
                                           page_break=(page>0)))
    entries['Contents/section0.xml'] = synth.section(paragraphs)
    target = OUT / (stem + '.hwpx')
    with zipfile.ZipFile(target, 'w') as archive:
        for name,data in entries.items():
            compression = zipfile.ZIP_STORED if name=='mimetype' else zipfile.ZIP_DEFLATED
            archive.writestr(synth.zip_info(name,compression),data)
    manifest = {
        'schema_version': 1, 'generator': 'generate_atlas.py', 'source_hwpx': str(target),
        'source_hwpx_sha256': sha(target), 'pdf': str(OUT/(stem+'.pdf')),
        'pdf_sha256': None, 'font_family': family, 'style': style,
        'hft_banks': selected_banks,
        'family_bank_inventory': banks,
        'hft_inventory_source_directory': str(HFT_DIR),
        'vertical_metrics_basis': 'inferred_from_em_box_pending_source_metric_decoding',
        'vertical_metrics': {'ascender_units': 800, 'descender_units': -200, 'line_gap_units': 0},
        'font_weight': 700 if 'Bold' in style else 400,
        'italic_angle_deg': italic_angle_deg if 'Italic' in style else 0.0,
        'italic_angle_basis': 'caller_supplied_after_Hancom_PDF_audit' if 'Italic' in style and italic_angle_deg is not None else 'unverified_until_Hancom_PDF_audit' if 'Italic' in style else 'upright_source_bank',
        'style_source': 'Hancom synthetic bold/italic HWPX charPr' if style != 'Regular' else 'HFT regular source bank',
        'probe_repeat': repeat,
        'space_probe_context': space_context,
        'coverage_scope': {'mapped_hangul': 'KS X 1001 EUC-KR rows B0A1..C8FE (2350 Unicode syllables)',
            'mapped_latin': 'U+0020..U+007E (95 characters)',
            'unmapped_hft_slots': f'Latin bank slots 0x7F..{latin_bank["source_code_end"]} excluded; no Unicode mapping claimed',
            'mapped_hanja': 'KS X 1001 EUC-KR rows CAA1..FDFE (4888 Unicode ideographs)' if any(ch in mapped_hanja for ch in chars) else 'not included in this atlas',
            'excluded_banks': [b['filename'] for b in banks if b['encoding'] not in ('latin_hft_0x20_0x85','latin_hft_ascii','ks_x_1001_hangul_2350','ks_x_1001_hanja_4888')],
            'unsupported_bank_reason': 'Unicode mapping or source record signature not yet verified',
            'selected_codepoint_count': len(chars),
            'excluded_source_codepoints': [{'codepoint':f'U+{cp:04X}',
                'reason':excluded_reason or 'Caller excluded source slot before Hancom PDF verification'}
                for cp in sorted(excluded_codepoints or [])]},
        'page_count_expected': pages, 'grid': {'columns': cols,'rows':rows,'cell_width_hwp':cell_w,
            'cell_height_hwp':cell_h,'page_left_pt':85.04,'page_top_pt':56.68},
        'entries': manifest_entries,
    }
    manifest_path = OUT/(stem+'.json')
    manifest_path.write_text(json.dumps(manifest,ensure_ascii=False,indent=2)+'\n')
    print(target,manifest_path,len(chars),'pages',pages)


def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('font',help='HFT family name or validation profile')
    parser.add_argument('--stem',help='출력 파일 접두어; 생략하면 글꼴 이름 해시 사용')
    parser.add_argument('--chars',default=None,help='literal characters in manifest order')
    parser.add_argument('--coverage',choices=['pilot','ks2350','hanja4888','full_mapped'],default='pilot')
    parser.add_argument('--font-size-pt',type=int,default=30)
    parser.add_argument('--style',choices=['Regular','Bold','Italic','Bold Italic'],default='Regular')
    parser.add_argument('--repeat',type=int,choices=[1,2],default=1,
                        help='2 creates paired glyphs for PDF advance measurement')
    parser.add_argument('--space-context',choices=['latin','hangul'],default='latin')
    parser.add_argument('--italic-angle-deg',type=float,
                        help='Italic 표본의 한컴 PDF에서 확인한 실제 기울기')
    parser.add_argument('--exclude-codepoint',action='append',default=[],
                        help='원본 슬롯을 명시적으로 제외 (예: U+0020)')
    parser.add_argument('--exclude-reason',help='제외 슬롯의 검증 사유')
    parser.add_argument('--latin-bank',help='같은 이름의 Latin 은행이 여럿이면 원본 파일 선택')
    parser.add_argument('--hangul-bank',help='같은 이름의 한글 은행이 여럿이면 원본 파일 선택')
    parser.add_argument('--hanja-bank',help='같은 이름의 한자 은행이 여럿이면 원본 파일 선택')
    parser.add_argument('--rhwp-root',type=Path,default=RHWP_ROOT)
    parser.add_argument('--source-hwpx',type=Path)
    parser.add_argument('--hft-dir',type=Path,default=DEFAULT_HFT_DIR)
    parser.add_argument('--out-dir',type=Path,default=Path.cwd())
    args=parser.parse_args()
    configure(rhwp_root=args.rhwp_root,
              source_hwpx=args.source_hwpx or args.rhwp_root/'samples/hwpx/ref/ref_empty.hwpx',
              hft_dir=args.hft_dir,out_dir=args.out_dir)
    chars = list(args.chars) if args.chars is not None else {
        'pilot': pilot_chars,
        'ks2350': lambda: list(map(chr,range(0x20,0x7f)))+ks2350_chars(),
        'hanja4888': hanja4888_chars,
        'full_mapped': lambda: list(map(chr,range(0x20,0x7f)))+ks2350_chars()+hanja4888_chars(),
    }[args.coverage]()
    excluded=set()
    for value in args.exclude_codepoint:
        cp=int(value[2:],16) if value.upper().startswith('U+') else int(value,0)
        excluded.add(cp)
    if excluded-set(map(ord,chars)):
        raise ValueError('제외 코드포인트가 생성 대상에 없습니다')
    chars=[ch for ch in chars if ord(ch) not in excluded]
    stem=args.stem or 'atlas-'+hashlib.sha256(args.font.encode()).hexdigest()[:12]
    generate(args.font,chars,stem,font_size_pt=args.font_size_pt,style=args.style,
             repeat=args.repeat,space_context=args.space_context,
             italic_angle_deg=args.italic_angle_deg,
             excluded_codepoints=excluded,excluded_reason=args.exclude_reason,
             latin_bank_name=args.latin_bank,
             hangul_bank_name=args.hangul_bank,hanja_bank_name=args.hanja_bank)

if __name__=='__main__':main()
