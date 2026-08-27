---
name: rhwp-editing
description: Pending-edit and revision workflow for changing the live HWP/HWPX document through the rhwp tools. Use before any write tool (insert_text, replace_range, apply_list, insert_equation, edit_table, ...), when a write returns REVISION_MISMATCH, or when planning a multi-step document edit.
---

# rhwp 문서 편집

## 시작

1. `get_structure` 를 먼저 불러 좌표(`sectionIdx`/`paraIdx`/`charOffset`)와 현재 `revision` 을 확보한다.
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

- 편집은 승인 전까지 색이 입혀진 대기 변경으로만 보인다. 삭제는 취소선으로 표시된다.
- **안전** 프로필: 자기 편집을 스스로 승인할 수 없다. 승인은 턴과 턴 사이에 사용자가 한다.
- **전체 접근** 프로필: 성공한 턴이 끝나면 대기 편집이 자동 확정된다.
- 승인을 기다리며 폴링·대기·재시도하지 않는다. 할 일을 끝내고 턴을 마친다.

## 도구 선택

- 목록은 `apply_list` 로 만든다. `1.` `가.` `•` 같은 마커를 직접 타이핑하지 않는다.
- 기존 텍스트 교체는 `replace_range` 를 쓴다. `delete_range` + `insert_text` 조합은 쓰지 않는다 —
  `replace_range` 가 원자적이고 서식을 보존한다.
- 수식은 `preview_equation` 을 먼저 부르고 경고를 오류로 취급해 고친 뒤 `insert_equation` 한다.
  스크립트는 LaTeX 가 아니라 한컴 수식 문법이다.
- 표 구조 변경(`insert_row`/`insert_col`/`merge_cells`)은 마지막에 몰아서 한다. 호출한 순간부터
  그 표는 사용자가 승인할 때까지 잠긴다. 표 작업은 `rhwp-tables` 스킬을 참고한다.

## 마무리

- 편집 묶음이 끝나면 `verify_changes` 로 스스로 검사한다. 레이아웃이 중요하면 `includeImage: true`.
- 검사에서 나온 문제를 고친 다음 턴을 끝낸다.
- 마지막은 도구 호출이나 진행 보고가 아니라, 무엇을 바꿨는지 알리고 문서와 대기 변경을 확인해
  달라고 요청하는 사용자용 메시지여야 한다.
