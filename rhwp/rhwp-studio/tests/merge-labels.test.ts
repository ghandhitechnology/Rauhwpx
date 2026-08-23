import assert from 'node:assert/strict';
import test from 'node:test';
import {
  formatMergeValue,
  mergeChoiceLabel,
  mergeErrorMessage,
  mergePathLabel,
  mergeTokenLabel,
} from '../src/merge/merge-labels.ts';

test('merge structure labels and paths hide internal English keys', () => {
  assert.equal(mergeTokenLabel('chart-series'), '차트 계열');
  assert.equal(mergeTokenLabel('unknown-control'), '알 수 없는 개체');
  assert.equal(mergeTokenLabel('fontSize'), '글꼴 크기');
  assert.match(mergeTokenLabel('implementationDetail'), /^기타 속성 #\d{4}$/);
  assert.notEqual(mergeTokenLabel('foo'), mergeTokenLabel('bar'));
  assert.equal(
    mergePathLabel(['sections', '0', 'paragraphs', '2', 'formatting']),
    '구역 / 1번 / 문단 / 3번 / 서식',
  );
});

test('merge editor choices use Korean labels while preserving stored values', () => {
  assert.equal(mergeChoiceLabel('justify'), '양쪽 맞춤');
  assert.equal(mergeChoiceLabel('insert-row'), '행 삽입');
  assert.equal(mergeChoiceLabel('right-to-left'), '오른쪽에서 왼쪽');
});

test('formatted conflict values localize property keys and redact image bytes', () => {
  const formatted = formatMergeValue({
    fontSize: 12,
    structureOperation: 'insert-row',
    visible: true,
    bytesBase64: 'ABCDEF',
  });
  assert.match(formatted, /"글꼴 크기": 12/);
  assert.match(formatted, /"구조 작업": "행 삽입"/);
  assert.match(formatted, /"표시": "예"/);
  assert.match(formatted, /"이미지 바이트": "\[base64 이미지: 6자\]"/);
  assert.doesNotMatch(formatted, /fontSize|structureOperation|bytesBase64|insert-row|true|ABCDEF/);
});

test('merge errors keep Korean detail and hide raw English worker failures', () => {
  assert.equal(mergeErrorMessage(new Error('테스트 실패')), '테스트 실패');
  assert.equal(
    mergeErrorMessage(new Error('worker crashed'), '문서를 미리 볼 수 없습니다.'),
    '문서를 미리 볼 수 없습니다.',
  );
  assert.equal(
    mergeErrorMessage({ code: 'STALE_WORKSPACE', message: 'stale' }),
    '병합하는 동안 브랜치가 변경되었습니다. 결과를 다시 확인하세요.',
  );
});
