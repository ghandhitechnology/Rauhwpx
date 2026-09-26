---
name: rhwp-editing
description: Pending-edit and revision workflow for changing the live HWP/HWPX document through the rhwp tools. Use before any write tool (insert_text, replace_range, apply_list, insert_equation, edit_table, ...), when a write returns REVISION_MISMATCH, or when planning a multi-step document edit.
---

# rhwp 문서 편집

## 시작

1. `get_structure` 를 먼저 불러 좌표(`sectionIdx`/`paraIdx`/`charOffset`)와 현재 `revision` 을 확보한다.
   결과는 문단마다 `s0 p12 (40) 텍스트…` 한 줄인 텍스트이고 둘째 줄이 범례다. JSON 이 필요하면 `format: "json"`.
2. 정확한 오프셋이 필요하면 `find_text` 로 위치를 찾는다. `charOffset` 은 텍스트 문자만 세므로
   표·그림 같은 인라인 컨트롤이 섞인 문단에서는 눈으로 센 값을 쓰지 않는다.
3. 원본 HWP/HWPX 파일은 셸이나 파일 도구로 절대 건드리지 않는다. 문서 변경은 rhwp 도구로만 한다.

## 리비전 사슬

- 모든 쓰기 도구는 `expectedRevision` 이 필요하다. 가장 최근 도구 응답이 준 `revision` 을 넣는다.
- 편집을 두 개 이상 미리 알고 있으면 `apply_edits` 한 번에 묶어 보낸다 (최대 32개). 항목은
  순서대로 적용되므로 서로 떨어진 위치를 고칠 때는 문서 뒤쪽부터 넣어 앞 항목이 뒤 좌표를
  밀지 않게 한다. 한 항목이라도 실패하면 묶음 전체가 되돌아간다.
- 낱개로 보낼 때는 **한 번에 하나씩**. 병렬로 보내지 말고, 응답의 새 `revision` 을 다음 쓰기에 넘긴다.
- `REVISION_MISMATCH` 가 나면 문서가 바뀐 것이다. 오류 메시지가 현재 `revision` 과 대처 방법을
  함께 주므로 그 안내를 따른다. 좌표가 밀렸을 가능성이 있으면 다시 읽어(`get_structure` /
  `get_text_range` / `find_text`) 좌표를 갱신한 뒤 재시도한다. 같은 좌표로 그냥 다시 보내면
  중복 삽입이 된다.

## 대기 편집

- 편집은 호출 즉시 문서에 적용되고, 승인 전까지 대기 변경으로 강조된다. 읽거나 렌더한 문서가 곧 승인 결과다.
- **안전** 프로필: 자기 편집을 스스로 승인할 수 없다. 승인은 턴과 턴 사이에 사용자가 한다.
- **전체 접근** 프로필: 성공한 턴이 끝나면 대기 편집이 자동 확정된다.
- 승인을 기다리며 폴링·대기·재시도하지 않는다. 할 일을 끝내고 턴을 마친다.

## 도구 선택

- 목록은 `apply_list` 로 만든다. `1.` `가.` `•` 같은 마커를 직접 타이핑하지 않는다.
- 기존 텍스트 교체는 `replace_range` 를 쓴다. `delete_range` + `insert_text` 조합은 쓰지 않는다 —
  `replace_range` 가 원자적이고 서식을 보존한다.
- 수식은 `preview_equation` 을 먼저 부르고 경고를 오류로 취급해 고친 뒤 `insert_equation` 한다.
  스크립트는 LaTeX 가 아니라 한컴 수식 문법이다.
- 표 구조 변경(`insert_row`/`delete_row`/`merge_cells` 등)은 즉시 적용되고 `cellIdx` 를 다시 매긴다.
  이후 셀은 돌려받은 개수나 새 `get_structure` 로 주소를 잡는다. 표 작업은 `rhwp-tables` 스킬을 참고한다.
- 그림·도형의 위치·크기·배치·자르기·앞뒤 순서·삭제는 `edit_object` 로 바꾼다(주소는 `get_page_geometry` 의 objects).
  선·사각형·타원·글상자는 `insert_shape` 로 넣고, 글상자 글은 돌려받은 `cell`/`cellPath` 로 텍스트 도구에 쓴다.
- 도구 결과에 `editReport` 가 있거나 턴이 `staged_edit_report` 블록으로 시작하면, 대기 편집 일부가 버려졌거나
  거절 뒤에도 문서에 남은 것이다. 그 부분을 다시 읽은 뒤 편집한다.

## 마무리

- 모든 쓰기와 `apply_edits` 는 `after` 보고(바뀐 문단 글, 쪽 수, 경고)를 돌려준다. 레이아웃이 중요하면
  `render: "crop"` 을 붙여 바뀐 영역 그림을 함께 받는다.
- `after.warnings` 가 없으면 끝낸다. 의도하지 않은 경고는 고친다. `verify_changes` 는 경고를 살필 때만 쓴다.
- 마지막은 도구 호출이나 진행 보고가 아니라, 무엇을 바꿨는지 알리고 문서와 대기 변경을 확인해
  달라고 요청하는 사용자용 메시지여야 한다.
