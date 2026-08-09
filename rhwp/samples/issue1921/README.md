# Issue #1921 검증 샘플

## 59043_regulatory_analysis.hwp
- 출처: hwpdocs 코퍼스 `opinion_downloads/보건복지부/59043_규제영향분석서.hwp`
  (국민참여입법센터 공개 규제영향분석서, 원본 그대로 복사).
- PR #2092(RowBreak 블록컷 sliver 흡수)의 핵심 개선 타깃 문서.
  - 최초 rhwp 48쪽 → sliver 수정 후 42쪽 → P0 parity 후 **37쪽**.
  - Square/Tight 셀 개체의 저장 cut 축과 시각적 packed extent를 통일하고,
    외곽 wrapper ownership·저장 page rewind·단 tail packing을 함께 정합했다.
- 기준 PDF: `pdf/issue1921/59043_regulatory_analysis-2022.pdf`
  (한글 2022 COM, Print 액션 1-up 강제 출력 37쪽 = 편집기 PageCount 37 정합).
  - 주의: FileSaveAsPdf 경로는 sticky 인쇄 설정(모아찍기)을 따라가므로
    `HPrint.PrintMethod=0` 명시 후 Print 액션으로 출력해야 권위 레이아웃이 나온다.
- 검증: `cargo test --test issue_1921_59043_pagination_pin` /
  `rhwp dump-pages samples/issue1921/59043_regulatory_analysis.hwp`
