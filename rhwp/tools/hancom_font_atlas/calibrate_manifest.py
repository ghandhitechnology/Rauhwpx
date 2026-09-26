#!/usr/bin/env python3
"""한컴 인쇄 PDF의 칸 클립과 글리프 변환을 목록에 기록한다."""
from __future__ import annotations
import argparse
import hashlib
import json
import re
from pathlib import Path
import pymupdf

NUM = r'[-+]?\d*\.?\d+'
CELL = re.compile(r'q\s+('+NUM+r')\s+('+NUM+r')\s+m\s+('+NUM+r')\s+('+NUM+r')\s+l\s+('+NUM+r')\s+('+NUM+r')\s+l\s+('+NUM+r')\s+('+NUM+r')\s+l\s+h\s+W\s+n')
CM = re.compile(r'('+NUM+r')\s+('+NUM+r')\s+('+NUM+r')\s+('+NUM+r')\s+('+NUM+r')\s+('+NUM+r')\s+cm')
FILL = re.compile(r'\s(?:B|b|f|f\*)\s')


def calibrate(manifest_path: Path):
    m = json.loads(manifest_path.read_text())
    pdf_path = Path(m['pdf'])
    pdf = pymupdf.open(pdf_path)
    if len(pdf) != m['page_count_expected']:
        raise ValueError(f"page count {len(pdf)} != {m['page_count_expected']}")
    m['pdf_sha256'] = hashlib.sha256(pdf_path.read_bytes()).hexdigest()
    m['pdf_page_sizes_pt'] = [[p.rect.width,p.rect.height] for p in pdf]
    evidence = []
    for page_no, page in enumerate(pdf,1):
        expected = [e for e in m['entries'] if e['page']==page_no]
        source = page.read_contents().decode('latin1')
        matches=list(CELL.finditer(source))
        if len(matches)!=len(expected):
            raise ValueError(f'page {page_no}: {len(matches)} clips != {len(expected)} entries')
        if page.get_text().strip() or page.get_fonts(full=True):
            raise ValueError(f'page {page_no}: substituted text/font objects present')
        records=[]
        for i,(entry,match) in enumerate(zip(expected,matches)):
            chunk=source[match.end():matches[i+1].start() if i+1<len(matches) else len(source)]
            vals=list(map(float,match.groups()))
            x0=min(vals[0],vals[2],vals[4],vals[6]);x1=max(vals[0],vals[2],vals[4],vals[6])
            y0=page.rect.height-max(vals[1],vals[3],vals[5],vals[7])
            y1=page.rect.height-min(vals[1],vals[3],vals[5],vals[7])
            rect=[round(v,5) for v in (x0,y0,x1,y1)]
            mat=CM.search(chunk)
            has_image=bool(re.search(r'/Im\d+\s+Do',chunk))
            has_fill=bool(FILL.search(chunk))
            status='vector_ink' if has_fill and not has_image else 'raster_or_image' if has_image else 'empty_or_other'
            entry['cell_rect_pt']=rect
            entry['pdf_observed_status']=status
            entry['pdf_object_kind']='vector_path' if has_fill and not has_image else 'image' if has_image else 'none'
            if status=='vector_ink':
                if not mat:raise ValueError(f'page {page_no} cell{i} has path without transform')
                a,b,c,d,x,y=map(float,mat.groups())
                if abs(a-entry['font_size_pt']/entry['em_units'])>0.0001 or abs(d-a)>0.0001 or b or c:
                    raise ValueError(f'page {page_no} cell{i} wrong HFT scale {mat.groups()}')
                entry['origin_pt']=[x,round(page.rect.height-y,5)]
                entry['baseline_pt']=entry['origin_pt'][1]
                entry['origin_basis']='pdf_ctm'
                entry['expected_status']='ink'
            elif entry['char']==' ' and has_image:
                images=page.get_images(full=True)
                if len(images)!=1:raise ValueError(f'page {page_no} blank image count {len(images)}')
                pix=pymupdf.Pixmap(pdf,images[0][0])
                if not pix.alpha or any(pix.samples):raise ValueError('blank image has visible pixels')
                latin_bank=next((b for b in m['hft_banks'] if b.get('encoding','').startswith('latin_hft_')),None)
                if not latin_bank:raise ValueError('검증된 Latin HFT 은행이 없습니다')
                width_offset=latin_bank['width_table_offset']+10
                entry['blank_proof']={'source_hft_bank':latin_bank['filename'],
                    'source_hft_bank_sha256':latin_bank['sha256'],
                    'source_hft_width_table_offset':f'0x{width_offset:X}',
                    'source_hft_advance_units':entry['advance_units'],'pdf_image_xref':images[0][0],
                    'pdf_image_samples_sha256':hashlib.sha256(pix.samples).hexdigest(),
                    'pdf_image_all_alpha_zero':True}
                entry['expected_status']='source_verified_blank'
                entry['origin_basis']='grid_interpolation'
                entry['origin_pt']=None
                entry['baseline_pt']=None
            else:
                raise ValueError(f'page {page_no} U+{ord(entry["char"]):04X} has {status}; review fallback')
            records.append(entry)
        # 빈 칸의 원점은 같은 줄에서 검증된 이웃 글리프를 기준으로 계산한다.
        for entry in records:
            if entry['expected_status']!='source_verified_blank':continue
            neighbor=next((x for x in records if x['row']==entry['row'] and x['expected_status']=='ink'),None)
            if not neighbor:raise ValueError(f'page {page_no} row {entry["row"]} has no origin anchor')
            x=neighbor['origin_pt'][0]+entry['cell_rect_pt'][0]-neighbor['cell_rect_pt'][0]
            entry['origin_pt']=[round(x,5),neighbor['origin_pt'][1]]
            entry['baseline_pt']=neighbor['baseline_pt']
        evidence.append({'page':page_no,'entries':len(expected),'vector_ink':sum(x['expected_status']=='ink' for x in records),
                         'verified_blank':sum(x['expected_status']=='source_verified_blank' for x in records),
                         'font_objects':0,'text_objects':0})
    # 빈 이미지의 픽셀이 실제로 투명한지 다시 확인한다.
    for page in pdf:
        for info in page.get_images(full=True):
            pix=pymupdf.Pixmap(pdf,info[0])
            if not pix.alpha or any(pix.samples):
                raise ValueError(f'nontransparent image xref={info[0]}')
    m['pdf_evidence']=evidence
    m['source_verified_blank_proof']='All PDF image XObjects are alpha-only and zero-valued; no visible raster ink.'
    manifest_path.write_text(json.dumps(m,ensure_ascii=False,indent=2)+'\n')
    print(manifest_path,m['pdf_sha256'],evidence)

if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('manifest',type=Path);calibrate(p.parse_args().manifest)
