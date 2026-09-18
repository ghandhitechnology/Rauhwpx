import test from 'node:test';
import assert from 'node:assert/strict';

import { readHwp16Input, readHwpunitInput } from '../src/ui/table-property-units.ts';

// 개체 속성 다이얼로그의 wrapValues 에는 core TextWrap 의 'Through'(빈 공간
// 채움)가 없어, Through 배치 개체의 속성창을 열면 배치 버튼이 전부 비활성이
// 된다. 이때 getSelectedWrap() 이 기본값 'Square' 를 반환하면 사용자가 아무
// 것도 바꾸지 않고 확인만 눌러도 textWrap diff 가 전송되어 배치가 조용히
// 변경·저장된다. 활성 버튼이 없으면 개체의 원래 배치 값을 보존해야 한다.

test('0.1mm 표시값을 수정하지 않으면 표와 셀의 원본 HU를 보존한다', () => {
  assert.equal(readHwpunitInput({ value: '0.4' }, 123), 123);
  assert.equal(readHwp16Input({ value: '0.4' }, 123), 123);
  assert.equal(readHwpunitInput({ value: '0.5' }, 123), 142);
  assert.equal(readHwp16Input({ value: '0.5' }, 123), 142);
});
