import test from 'node:test';
import assert from 'node:assert/strict';

import {
  fontFamilyChainForDisplay,
  fontFamilyWithFallback,
  resolveFont,
} from '../src/core/font-substitution.ts';

test('resolveFont는 기존 웹 대체 글꼴 해소를 유지한다', () => {
  assert.equal(resolveFont('휴먼명조', 0, 0), 'HY신명조');
  assert.equal(resolveFont('신명 중고딕', 0, 0), 'HY중고딕');
});

test('fontFamilyChainForDisplay는 미승인 로컬 글꼴명을 웹 대체 글꼴보다 앞에 두지 않는다', () => {
  const chain = fontFamilyChainForDisplay('휴먼명조', 0, 0);

  assert.match(chain, /^"HY신명조"/);
  assert.doesNotMatch(chain, /"휴먼명조"/);
  assert.match(chain, /"Noto Serif KR"/);
  assert.match(chain, /serif$/);
});

test('fontFamilyChainForDisplay는 확인된 로컬 글꼴을 웹 대체 글꼴보다 앞에 둔다', () => {
  const chain = fontFamilyChainForDisplay('휴먼명조', 0, 0, {
    confirmedLocalFonts: ['휴먼명조'],
  });

  assert.match(chain, /^"휴먼명조", "HY신명조"/);
  assert.match(chain, /"Noto Serif KR"/);
  assert.match(chain, /serif$/);
});

test('fontFamilyChainForDisplay는 등록 웹폰트도 시스템 fallback을 붙인다', () => {
  const chain = fontFamilyChainForDisplay('함초롬바탕', 0, 0);

  assert.match(chain, /^"함초롬바탕"/);
  assert.match(chain, /"Noto Serif KR"/);
  assert.match(chain, /serif$/);
});

test('fontFamilyChainForDisplay는 중복 없이 generic font를 그대로 처리한다', () => {
  assert.equal(fontFamilyChainForDisplay('serif', 0, 0), 'serif');
  assert.equal(
    fontFamilyChainForDisplay('없는글꼴', 0, 0),
    '"함초롬돋움", "Malgun Gothic", "Apple SD Gothic Neo", "Noto Sans KR", "Pretendard", sans-serif',
  );
  assert.equal(
    fontFamilyChainForDisplay('없는글꼴', 0, 0, { confirmedLocalFonts: ['없는글꼴'] }),
    '"없는글꼴", "함초롬돋움", "Malgun Gothic", "Apple SD Gothic Neo", "Noto Sans KR", "Pretendard", sans-serif',
  );
});

test('한컴 고딕 대체 글꼴은 원본 뒤에 와서 누락된 글립만 채운다', () => {
  const chain = fontFamilyChainForDisplay('맑은 고딕', 0, 0, {
    confirmedLocalFonts: ['맑은 고딕'],
  });
  assert.match(chain, /^"맑은 고딕", "함초롬돋움", "Malgun Gothic"/);
});

test('fontFamilyWithFallback 기존 helper는 동일한 fallback 계열을 사용한다', () => {
  assert.equal(
    fontFamilyWithFallback('굴림체'),
    '"굴림체", "GulimChe", "D2Coding", "Noto Sans Mono", monospace',
  );
});

test('수식 글꼴의 변수와 숫자는 본문 고딕 fallback으로 치환하지 않는다', () => {
  for (const family of ['HYhwpEQ', 'HyhwpEQ', 'Latin Modern Math', 'STIX Two Math', 'Cambria Math']) {
    const chain = fontFamilyChainForDisplay(family);
    assert.match(chain, /^"(?:Times New Roman|Latin Modern Math)"/);
    assert.match(chain, /"STIX Two Text"/);
    assert.match(chain, /"Times New Roman"/);
    assert.match(chain, /serif$/);
    assert.doesNotMatch(chain, /sans-serif|Malgun|Noto Sans/);
  }

  const installed = fontFamilyChainForDisplay('HYhwpEQ', 0, 0, {
    confirmedLocalFonts: ['HYhwpEQ'],
  });
  assert.match(installed, /^"HYhwpEQ", "Times New Roman"/);
});
