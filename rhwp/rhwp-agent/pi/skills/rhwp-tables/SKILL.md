---
name: rhwp-tables
description: Address table cells and change table structure in the live HWP/HWPX document. Use when reading or editing text inside a table cell, when calling create_table or edit_table, or when a cell address is rejected.
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

빠뜨리면 `INVALID_ARGS` 로 즉시 실패한다. 길이는 mm, 글자 크기는 pt, 색은 `"#RRGGBB"` 다.

## 순서

- 셀 텍스트를 먼저 채우고 구조 변경을 뒤로 미룬다. `insert_row`/`insert_col`/`merge_cells` 를
  부르면 그 표는 사용자가 승인할 때까지 잠겨 추가 편집을 받지 않는다.
- 모든 호출은 `expectedRevision` 이 필요하고 한 번에 하나씩 보낸다 (`rhwp-editing` 참고).
- 표 작업이 끝나면 `verify_changes` 를 `includeImage: true` 로 불러 레이아웃을 확인한다.
