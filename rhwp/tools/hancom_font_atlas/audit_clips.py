#!/usr/bin/env python3
"""한컴 PDF 글리프가 표 칸 밖으로 뻗은 범위를 검증하고 기록한다."""
from __future__ import annotations
import argparse
import hashlib
import json
from pathlib import Path
import pymupdf

TOLERANCE_PT=0.25


def audit(manifest_path: Path, max_top_pt: float):
    if not 0<max_top_pt<=1:
        raise ValueError('허용할 위쪽 돌출은 0보다 크고 1pt 이하여야 합니다')
    manifest=json.loads(manifest_path.read_text())
    pdf_path=Path(manifest['pdf'])
    if not pdf_path.is_absolute():pdf_path=manifest_path.parent/pdf_path
    digest=hashlib.sha256(pdf_path.read_bytes()).hexdigest()
    if manifest.get('pdf_sha256')!=digest:
        raise ValueError('PDF 해시가 보정 목록과 다릅니다')
    document=pymupdf.open(pdf_path)
    if len(document)!=manifest['page_count_expected']:
        raise ValueError('PDF 쪽 수가 보정 목록과 다릅니다')
    by_page={}
    for entry in manifest['entries']:
        by_page.setdefault(entry['page'],[]).append(entry)
        entry.pop('max_path_protrusion_pt',None)
        entry.pop('protrusion_basis',None)
        entry.pop('protrusion_audit',None)
    anomalies=[]
    path_count=0
    assigned=set()
    for page_number,page in enumerate(document,1):
        entries=by_page.get(page_number,[])
        for drawing in page.get_drawings():
            path_count+=1
            rect=drawing['rect']
            midpoint=(rect.tl+rect.br)/2
            hits=[entry for entry in entries
                  if pymupdf.Rect(entry['cell_rect_pt']).contains(midpoint)]
            if len(hits)!=1:
                raise ValueError(f'{page_number}쪽 벡터의 소속 칸이 {len(hits)}개입니다: {rect}')
            entry=hits[0]
            if entry['expected_status']!='ink':
                raise ValueError(f'{entry["codepoint"]} 빈 칸에 벡터가 있습니다')
            assigned.add(entry['codepoint'])
            cell=pymupdf.Rect(entry['cell_rect_pt'])
            left=max(0.0,cell.x0-rect.x0)
            top=max(0.0,cell.y0-rect.y0)
            right=max(0.0,rect.x1-cell.x1)
            bottom=max(0.0,rect.y1-cell.y1)
            if max(left,right,bottom)>TOLERANCE_PT:
                raise ValueError(f'{entry["codepoint"]} 좌우/아래 칸 침범: {left,right,bottom}')
            if top>TOLERANCE_PT:
                if top>max_top_pt:
                    raise ValueError(f'{entry["codepoint"]} 위쪽 돌출 {top:.5f}pt > {max_top_pt}pt')
                entry['max_path_protrusion_pt']=max_top_pt
                entry['protrusion_basis']='pdf_clip_extends_above_cell'
                entry['protrusion_audit']=f'PDF page {page_number} vector top {top:.5f}pt above exact clip; unique cell-center assignment.'
                anomalies.append({'codepoint':entry['codepoint'],'page':page_number,
                                  'top_protrusion_pt':round(top,5),
                                  'cell_rect_pt':entry['cell_rect_pt'],
                                  'vector_rect_pt':[round(v,5) for v in rect]})
    missing=[entry['codepoint'] for entry in manifest['entries']
             if entry['expected_status']=='ink' and entry['codepoint'] not in assigned]
    if missing:
        raise ValueError(f'벡터가 없는 글리프 {len(missing)}개: {missing[:10]}')
    report={'schema_version':1,'manifest':str(manifest_path.resolve()),
            'pdf_sha256':digest,'vector_count':path_count,
            'top_tolerance_pt':max_top_pt,'side_bottom_tolerance_pt':TOLERANCE_PT,
            'audited_top_protrusions':anomalies}
    report_path=manifest_path.with_suffix('.clip-audit.json')
    report_path.write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n')
    manifest['pdf_clip_audit']={'report':str(report_path),
        'report_sha256':hashlib.sha256(report_path.read_bytes()).hexdigest(),
        'vector_count':path_count,'audited_top_protrusion_count':len(anomalies),
        'accept_top_protrusions_up_to_pt':max_top_pt}
    manifest_path.write_text(json.dumps(manifest,ensure_ascii=False,indent=2)+'\n')
    print(report_path,'vector_paths',path_count,'audited_top_protrusions',len(anomalies),
          [x['codepoint'] for x in anomalies])

if __name__=='__main__':
    parser=argparse.ArgumentParser()
    parser.add_argument('manifest',type=Path)
    parser.add_argument('--accept-top-protrusions-up-to-pt',required=True,type=float)
    args=parser.parse_args()
    audit(args.manifest,args.accept_top_protrusions_up_to_pt)
