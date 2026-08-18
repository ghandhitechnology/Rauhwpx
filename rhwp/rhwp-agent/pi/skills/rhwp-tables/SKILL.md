---
name: rhwp-tables
description: Address table cells and change table structure in the live HWP/HWPX document. Use when reading or editing text inside a table cell, when calling create_table, edit_table, get_table_layout, or delete_table, when a table runs off the page, or when a cell address is rejected.
---

# rhwp 표 다루기

## 셀 주소 조립

- `get_structure` 의 `tables[]` 항목이 표 컨트롤의 `paraIdx` 와 `controlIdx` 를 준다.
- 셀 주소는 `cell = { paraIdx, controlIdx, cellIdx }` 세 값이 모두 있어야 한다.
  `cellIdx` 는 행 우선 평면 인덱스이고 병합된 셀은 한 번만 센다.
- `get_structure` 의 셀별 항목에는 `paraIdx`/`controlIdx` 가 없다. 표 항목에서 가져와 직접 붙인다.
- `find_text` 결과에 들어 있는 `cell` 객체는 완전하다. 그대로 복사해 쓰는 쪽이 안전하다.
- `cell` 을 넘기면 `paraIdx`/`startParaIdx`/`endParaIdx` 와 모든 오프셋이 그 셀 내부 기준이 된다.

## create_table

- `rows` + `cols` 를 주거나 `cells` 그리드를 준다. 둘 중 하나는 반드시 필요하다.
- `cells` 를 주면 행·열 수는 그리드에서 추론되므로 `rows`/`cols` 를 따로 줄 필요가 없다.

## edit_table 의 op 별 필수 파라미터

| op | 필수 |
| --- | --- |
| `insert_row` / `delete_row` | `rowIdx` |
| `insert_col` / `delete_col` | `colIdx` |
| `merge_cells` | `startRow`, `startCol`, `endRow`, `endCol` |
| `set_cell_props` | `cellIdx`, `props` |
| `set_table_props` | `props` |
| `set_column_widths` | `columnWidthsMm` |
| `fit_to_page` | 없음 |
| `set_zone_borders` | `startCell`, `endCell` |
| `apply_formula` | `row`, `col`, `formula` |
| `set_caption` | `text` |

빠뜨리면 `INVALID_ARGS` 로 즉시 실패한다. 길이는 mm, 글자 크기는 pt, 색은 `"#RRGGBB"` 다.

## 폭·테두리·계산식·캡션

- `set_column_widths` 는 `columnWidthsMm` 로 열 폭을 절대 지정한다. 배열 길이가 열 수와
  다르면 거절된다. 표 전체 폭은 합계로 갱신된다.
- `fit_to_page` 는 본문 폭을 넘는 표의 열을 비례 축소해 한 쪽 안에 넣는다. 이미 들어가는
  표는 넓히지 않는다.
- `set_zone_borders` 는 `startCell{row,col}`~`endCell{row,col}` 사각형을 한 덩어리로 보고
  `borderLeft`/`borderRight`/`borderTop`/`borderBottom`(각각 `{type, width, color}`),
  `fillColor`, 그리고 필요하면 `diagonalLine`/`diagonalSlash`/`diagonalBackSlash`/
  `diagonalWidth`/`diagonalColor`, `centerLine`(`NONE`|`VERTICAL`|`HORIZONTAL`|`CROSS`)
  을 적용한다. 테두리는 범위의 바깥 윤곽에 걸리고 안쪽 칸 경계에는 걸리지 않는다.
- `apply_formula` 는 `=SUM(A1:B3)`, `=AVG(left)` 같은 한컴 계산식을 계산해 `(row, col)` 셀에
  결과를 넣는다. `format {decimalPlaces, thousandsSeparator, prefix, suffix}` 로 표기를
  정한다. 예: `{decimalPlaces: 0, thousandsSeparator: true, suffix: "원"}` → `1,234원`.
- `set_caption` 은 표 아래 캡션 글을 넣는다. 캡션이 없으면 만든다. `withNumber` 는 기본값이
  `true` 이고, 자동 번호(`표 N`) 없이 글만 넣으려면 `false` 를 준다.

## get_table_layout

- 표가 실제로 어느 쪽 어디에 놓였는지 읽는다. `fragments[]` 는 표가 걸친 쪽마다
  `{pageIndex, xMm, yMm, widthMm, heightMm}` 를 주고, 항목이 둘 이상이면 이미 쪽이 나뉜 것이다.
- `overflowsBody` 가 `true` 면 표가 본문 영역 아래로 넘쳤고, `overflowsBodyWidth` 가 `true` 면
  본문 폭보다 넓다.
- 세로로 넘치는데 `pageBreak` 가 0(나누지 않음)이면 `edit_table set_table_props` 에
  `{pageBreak: "row"}` 를 줘서 다음 쪽으로 이어지게 한다. 제목 행을 반복하려면
  `{repeatHeader: true}` 를 함께 준다.
- 가로로 넘치면 `fit_to_page` 를 부르거나 `set_column_widths` 로 폭을 다시 잡는다.

## delete_table

- 표 전체를 지운다. 주소는 `get_structure` 의 `tables[]` 에서 온 `sectionIdx`/`paraIdx`/`controlIdx` 다.
- mark-only: 승인 전까지 표는 그대로 있고 하이라이트만 된다. 거절하면 아무 것도 지우지 않는다.
- 같은 표에 대한 후속 편집은 승인/거절 전까지 `PENDING_DESTRUCTIVE_OP` 로 거절된다.

## 순서

- 셀 텍스트를 먼저 채우고 구조 변경을 뒤로 미룬다. `insert_row`/`insert_col`/`merge_cells`/`delete_table` 를
  부르면 그 표는 사용자가 승인할 때까지 잠겨 추가 편집을 받지 않는다.
- 모든 호출은 `expectedRevision` 이 필요하고 한 번에 하나씩 보낸다 (`rhwp-editing` 참고).
- 폭·테두리·계산식·캡션 op 도 mark-only 다. 승인(또는 턴 자동 확정) 전까지는 문서가 바뀌지 않는다.
- 표 작업이 끝나면 `verify_changes` 를 `includeImage: true` 로 불러 레이아웃을 확인하고,
  쪽 넘침이 의심되면 `get_table_layout` 으로 확인한다.
