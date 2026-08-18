import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildInlineSelection,
  extractSelectionText,
  selectionExcerpt,
  selectionLabel,
  type SelectionTextProbe,
} from '../src/agent/inline-prompt-context.ts';

/** 구역마다 같은 문단 목록을 돌려주는 단순 프로브. 논리→텍스트 변환은 -shift. */
function probeFor(paragraphs: string[], logicalShift = 0): SelectionTextProbe {
  return {
    paragraphCount: () => paragraphs.length,
    paragraphLength: (_sec, para) => [...(paragraphs[para] ?? '')].length,
    text: (_sec, para, from, count) => [...(paragraphs[para] ?? '')].slice(from, from + count).join(''),
    toTextOffset: (_sec, _para, logical) => logical - logicalShift,
  };
}

test('extractSelectionText: 한 문단 안의 선택을 그대로 자른다', () => {
  const probe = probeFor(['안녕하세요 세계']);
  const result = extractSelectionText(
    { sectionIndex: 0, paragraphIndex: 0, charOffset: 2 },
    { sectionIndex: 0, paragraphIndex: 0, charOffset: 6 },
    probe,
  );
  assert.equal(result.text, '하세요 ');
  assert.equal(result.truncated, false);
  assert.deepEqual(result.start, { sectionIdx: 0, paraIdx: 0, charOffset: 2 });
  assert.deepEqual(result.end, { sectionIdx: 0, paraIdx: 0, charOffset: 6 });
});

test('extractSelectionText: 여러 문단은 개행으로 잇고 경계 오프셋을 지킨다', () => {
  const probe = probeFor(['첫 문단', '가운데', '마지막 문단']);
  const result = extractSelectionText(
    { sectionIndex: 0, paragraphIndex: 0, charOffset: 2 },
    { sectionIndex: 0, paragraphIndex: 2, charOffset: 3 },
    probe,
  );
  assert.equal(result.text, '문단\n가운데\n마지막');
});

test('extractSelectionText: 논리 오프셋을 텍스트 오프셋으로 변환해 좌표를 내보낸다', () => {
  // 인라인 컨트롤 1개가 앞에 있어 논리 오프셋이 텍스트보다 1 크다.
  const probe = probeFor(['본문 텍스트'], 1);
  const result = extractSelectionText(
    { sectionIndex: 0, paragraphIndex: 0, charOffset: 1 },
    { sectionIndex: 0, paragraphIndex: 0, charOffset: 4 },
    probe,
  );
  assert.equal(result.text, '본문 ');
  assert.deepEqual(result.start, { sectionIdx: 0, paraIdx: 0, charOffset: 0 });
  assert.deepEqual(result.end, { sectionIdx: 0, paraIdx: 0, charOffset: 3 });
});

test('extractSelectionText: 상한을 넘으면 잘리고 truncated 를 표시한다', () => {
  const probe = probeFor(['가'.repeat(50), '나'.repeat(50)]);
  const result = extractSelectionText(
    { sectionIndex: 0, paragraphIndex: 0, charOffset: 0 },
    { sectionIndex: 0, paragraphIndex: 1, charOffset: 50 },
    probe,
    60,
  );
  assert.equal(result.truncated, true);
  assert.equal(result.text, '가'.repeat(50) + '\n' + '나'.repeat(10));
});

test('selectionExcerpt: 공백을 접고 길면 말줄임한다', () => {
  assert.equal(selectionExcerpt('  줄1\n줄2\t줄3  '), '줄1 줄2 줄3');
  const long = selectionExcerpt('가'.repeat(100));
  assert.equal([...long].length, 80);
  assert.ok(long.endsWith('…'));
});

test('selectionLabel: 사람 기준 1-based 로 표기한다', () => {
  assert.equal(
    selectionLabel({ sectionIdx: 0, paraIdx: 3, charOffset: 0 }, { sectionIdx: 0, paraIdx: 3, charOffset: 9 }),
    '문단 4',
  );
  assert.equal(
    selectionLabel({ sectionIdx: 0, paraIdx: 3, charOffset: 0 }, { sectionIdx: 0, paraIdx: 5, charOffset: 2 }),
    '문단 4–6',
  );
  assert.equal(
    selectionLabel({ sectionIdx: 0, paraIdx: 3, charOffset: 0 }, { sectionIdx: 1, paraIdx: 1, charOffset: 2 }),
    '구역 1 문단 4 – 구역 2 문단 2',
  );
});

test('buildInlineSelection: 컨텍스트 블록에 좌표와 선택 텍스트가 들어간다', () => {
  const built = buildInlineSelection({
    start: { sectionIdx: 0, paraIdx: 3, charOffset: 10 },
    end: { sectionIdx: 0, paraIdx: 5, charOffset: 4 },
    text: '선택된 본문',
    truncated: false,
  });
  assert.equal(built.label, '문단 4–6');
  assert.equal(built.excerpt, '선택된 본문');
  assert.ok(built.contextBlock.includes('sectionIdx 0 paraIdx 3 charOffset 10'));
  assert.ok(built.contextBlock.includes('sectionIdx 0 paraIdx 5 charOffset 4'));
  assert.ok(built.contextBlock.includes('<<<SELECTION\n선택된 본문\nSELECTION>>>'));
  assert.ok(!built.contextBlock.includes('잘려'));
});

test('buildInlineSelection: 잘린 선택은 블록에 표시한다', () => {
  const built = buildInlineSelection({
    start: { sectionIdx: 0, paraIdx: 0, charOffset: 0 },
    end: { sectionIdx: 0, paraIdx: 0, charOffset: 9000 },
    text: '앞부분',
    truncated: true,
  });
  assert.ok(built.contextBlock.includes('앞부분만 표시'));
});
