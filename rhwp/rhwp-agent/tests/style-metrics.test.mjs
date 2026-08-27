import assert from 'node:assert/strict';
import test from 'node:test';

import {
  analyzeText, baselineLines, confidenceFor, deriveBands, splitHalfStability, splitSentences,
} from '../style-metrics.mjs';

const KO_SAMPLE = [
  '예산은 3,200만 원이 남았다. 3분기까지 쓰면 부족하다.',
  '담당자는 2026년 2월에 바뀌었습니다. 인수인계 문서는 아직 없습니다. 그래서 같은 질문이 반복됩니다.',
  '보고서는 짧게 쓴다. 표 하나와 문단 세 개면 충분하다. 길어지면 아무도 읽지 않는다.',
].join('\n\n');

test('한국어 원고에서 문장·문단·종결어미를 센다', () => {
  const metrics = analyzeText(KO_SAMPLE, 'ko');
  assert.equal(metrics.language, 'ko');
  assert.equal(metrics.paragraphs, 3);
  assert.equal(metrics.sentences, 8);
  assert.ok(metrics.endingMix.formal > 0, '합니다체 문장이 잡혀야 한다');
  assert.ok(metrics.endingMix.plain > 0, '한다체 문장이 잡혀야 한다');
  assert.ok(metrics.digitsPer1kChars > 0, '수치 밀도가 잡혀야 한다');
  assert.ok(metrics.sentenceLength.median > 0 && metrics.sentenceLength.p90 >= metrics.sentenceLength.median);
});

test('문장 분할은 한국어 마침과 영어 마침을 함께 처리한다', () => {
  assert.equal(splitSentences('짧다. 그리고 조금 더 길다.', 'ko').length, 2);
  assert.equal(splitSentences('Short one. And a longer second one.', 'en').length, 2);
});

test('영어 원고는 단어 기준으로 길이를 잰다', () => {
  const metrics = analyzeText('The budget is short. However, the team shipped it anyway and nobody complained.', 'en');
  assert.equal(metrics.endingMix, null);
  assert.equal(metrics.sentences, 2);
  assert.ok(metrics.connectiveOpenRate > 0, 'However 로 시작한 문장이 접속어 개시로 잡혀야 한다');
});

test('표본이 얇으면 신뢰도가 내려가고 밴드가 넓어진다', () => {
  const metrics = analyzeText(KO_SAMPLE, 'ko');
  const stability = splitHalfStability(KO_SAMPLE, 'ko');
  assert.equal(confidenceFor(metrics, stability), 'low');
  const tight = deriveBands(metrics, 'high');
  const loose = deriveBands(metrics, 'low');
  assert.ok(loose.sentenceLength.high >= tight.sentenceLength.high);
  assert.ok(loose.sentenceLength.low <= tight.sentenceLength.low);
});

test('기준선 문장은 작성 중 목표가 아니라 쓴 뒤의 지문으로 읽힌다', () => {
  const metrics = analyzeText(KO_SAMPLE, 'ko');
  const lines = baselineLines(deriveBands(metrics, 'medium'), 'ko');
  assert.ok(lines.some((line) => /문장 길이 지문: 중앙값/.test(line)));
  assert.ok(lines.some((line) => /종결어미/.test(line)));
  assert.ok(lines.some((line) => /맞추려고 글자를 보태거나 빼지 않는다/.test(line)));
  assert.ok(lines.every((line) => !/검사|위반|점검/.test(line)));
});

test('반쪽 일치도는 0과 1 사이에 머문다', () => {
  const long = `${KO_SAMPLE}\n\n`.repeat(12);
  const stability = splitHalfStability(long, 'ko');
  assert.ok(stability >= 0 && stability <= 1);
});
