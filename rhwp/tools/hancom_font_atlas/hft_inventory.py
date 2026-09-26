#!/usr/bin/env python3
"""Hancom HFT 머리말을 읽어 글꼴 묶음과 지원 은행을 조사한다."""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path

HFT_DIR = Path('/Applications/Hancom Office HWP.app/Contents/Resources/Hnc/Shared/Fonts')
MAGIC = b'Han Unified Font File 1.0\x1a'


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def read_bank(path: Path) -> dict:
    data = path.read_bytes()
    if not data.startswith(MAGIC) or len(data) < 0x1b2:
        raise ValueError(f'지원하지 않는 HFT 머리말: {path}')
    raw_name = data[0x6c:0x8c].split(b'\0', 1)[0]
    try:
        family = raw_name.decode('johab').strip()
    except UnicodeDecodeError as exc:
        raise ValueError(f'글꼴 이름 디코딩 실패: {path}') from exc
    width_offset = int.from_bytes(data[0x1aa:0x1ae], 'little')
    outline_offset = int.from_bytes(data[0x1ae:0x1b2], 'little')
    em_candidates = [int.from_bytes(data[i:i+2], 'little')
                     for i in (0x17a, 0x17e, 0x180, 0x182)]
    design_units_per_em = em_candidates[0] if len(set(em_candidates))==1 and 500<=em_candidates[0]<=4096 else None
    if width_offset < 0x200 or outline_offset < width_offset+10 or outline_offset >= len(data):
        raise ValueError(f'잘못된 HFT 테이블 주소: {path}')
    width_block_bytes = int.from_bytes(data[width_offset:width_offset+4], 'little')
    if width_block_bytes < 10 or width_offset + width_block_bytes > outline_offset:
        raise ValueError(f'너비 블록이 윤곽선 주소와 겹칩니다: {path}')
    first = int.from_bytes(data[width_offset+4:width_offset+6], 'little')
    last = int.from_bytes(data[width_offset+6:width_offset+8], 'little')
    record_type = int.from_bytes(data[width_offset+8:width_offset+10], 'little')
    if (first, last, record_type) == (0x20, 0x85, 1):
        encoding = 'latin_hft_0x20_0x85'
        mapped_count = 95
        source_count = 102
        if width_block_bytes != 10 + 2*source_count:
            raise ValueError(f'Latin 글자 폭 수가 원본 범위와 다릅니다: {path}')
    elif first == 0x20 and last >= 0x7e and record_type == 1:
        encoding = 'latin_hft_ascii'
        mapped_count = 95
        source_count = last-first+1
        if width_block_bytes != 10 + 2*source_count:
            raise ValueError(f'Latin 글자 폭 수가 원본 범위와 다릅니다: {path}')
    elif (first, last, record_type) == (0x8000, 0xffff, 0):
        if path.stem.endswith('HG') or path.stem.startswith('HG'):
            encoding = 'ks_x_1001_hangul_2350'
            mapped_count = 2350
            source_count = None
        elif path.stem.endswith('JP'):
            encoding = 'hft_japanese_unmapped'
            mapped_count = 0
            source_count = None
        else:
            encoding = 'unknown_0x8000_bank'
            mapped_count = 0
            source_count = None
    elif (first, last, record_type) == (0x4000, 0x5317, 0):
        encoding = 'ks_x_1001_hanja_4888'
        mapped_count = 4888
        source_count = None
    else:
        encoding = 'unsupported_header_signature'
        mapped_count = 0
        source_count = None
    return {
        'filename': path.name,
        'path': str(path.resolve()),
        'sha256': hashlib.sha256(data).hexdigest(),
        'bytes': len(data),
        'family': family,
        'hft_version': data[:26].decode('ascii', 'replace'),
        'encoding': encoding,
        'source_code_start': f'0x{first:04X}',
        'source_code_end': f'0x{last:04X}',
        'record_type': record_type,
        'source_glyph_count': source_count,
        'candidate_unicode_mapping_count': mapped_count,
        'source_count_basis': 'width_block_verified' if source_count is not None else 'Unicode_encoding_candidate_requires_PDF_vector_verification',
        'design_units_per_em': design_units_per_em,
        'design_em_header_candidates': em_candidates,
        'design_em_basis': 'four_repeated_HFT_header_fields' if design_units_per_em else 'header_fields_disagree_or_out_of_range_requires_PDF_audit',
        'unicode_mapped_count': mapped_count,
        'width_table_offset': width_offset,
        'width_block_bytes': width_block_bytes,
        'width_to_outline_gap_bytes': outline_offset-(width_offset+width_block_bytes),
        'outline_table_offset': outline_offset,
    }


def inventory(directory: Path = HFT_DIR) -> dict:
    families: dict[str, list[dict]] = {}
    rejected = []
    for path in sorted(p for p in directory.iterdir() if p.is_file() and p.suffix.lower()=='.hft'):
        try:
            bank = read_bank(path)
        except ValueError as exc:
            rejected.append({'path': str(path), 'reason': str(exc)})
            continue
        families.setdefault(bank['family'], []).append(bank)
    return {'inventory_schema_version': 1, 'source_directory': str(directory.resolve()),
            'families': families, 'rejected': rejected}


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--hft-dir', type=Path, default=HFT_DIR)
    parser.add_argument('--out', type=Path, help='결과 JSON 경로; 생략하면 표준 출력')
    args = parser.parse_args()
    rendered=json.dumps(inventory(args.hft_dir), ensure_ascii=False, indent=2)+'\n'
    if args.out:
        args.out.parent.mkdir(parents=True,exist_ok=True)
        args.out.write_text(rendered)
    else:
        print(rendered,end='')
