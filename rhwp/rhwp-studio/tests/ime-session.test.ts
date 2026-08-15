import assert from 'node:assert/strict';
import test from 'node:test';
import { ImeSession } from '../src/engine/ime-session.ts';

test('조합 세션은 compositionend 데이터로 정확히 한 번만 커밋한다', () => {
  const session = new ImeSession();

  session.start();
  session.update('ㅇ');
  session.update('아');
  session.update('안');

  assert.deepEqual(session.finish('안', '안'), { generation: 1, text: '안' });
  assert.equal(session.finish('안', '안'), null);
  assert.equal(session.isComposing, false);
});

test('강제 종료는 마지막 preedit를 보존하고 취소 종료는 빈 커밋을 만든다', () => {
  const session = new ImeSession();

  session.start();
  session.update('녕');
  assert.deepEqual(session.finish(undefined, ''), { generation: 1, text: '녕' });

  session.start();
  session.update('ㅎ');
  assert.deepEqual(session.finish('', ''), { generation: 2, text: '' });

  session.start();
  session.update('취소되지 않을 값');
  session.cancel();
  assert.deepEqual(session.finish('', '취소되지 않을 값'), { generation: 3, text: '' });
});

test('compositionend 뒤 커밋 input은 이벤트 의미로 한 번만 소비한다', () => {
  const session = new ImeSession();
  session.start();
  session.update('가');
  session.finish('가', '가');

  assert.equal(session.consumeTrailingInput({
    inputType: 'insertFromComposition',
    data: '가',
    isComposing: false,
    value: '가',
  }), true);
  assert.equal(session.consumeTrailingInput({
    inputType: 'insertFromComposition',
    data: '가',
    isComposing: false,
    value: '가',
  }), false);
});

test('inputType을 비우는 레거시 엔진의 trailing input도 한 번만 소비한다', () => {
  const session = new ImeSession();
  session.start();
  session.update('한');
  session.finish('한', '한');

  assert.equal(session.consumeTrailingInput({
    inputType: '',
    data: '한',
    isComposing: false,
    value: '한',
  }), true);
});

test('빠르게 이어진 같은 글자의 새 조합 입력을 삼키지 않는다', () => {
  const session = new ImeSession();
  session.start();
  session.update('가');
  session.finish('가', '가');

  session.start();
  assert.equal(session.consumeTrailingInput({
    inputType: 'insertCompositionText',
    data: '가',
    isComposing: true,
    value: '가',
  }), false);
  assert.equal(session.update('가'), '가');
  assert.deepEqual(session.finish('가', '가'), { generation: 2, text: '가' });
});

test('새 세션 중 늦게 도착한 이전 커밋 input만 소비한다', () => {
  const session = new ImeSession();
  session.start();
  session.update('가');
  session.finish('가', '가');
  session.start();

  assert.equal(session.consumeTrailingInput({
    inputType: 'insertFromComposition',
    data: '가',
    isComposing: false,
    value: '가',
  }), true);
  assert.equal(session.isComposing, true);
});

test('더 최신 세션 종료 뒤 도착한 이전 commit input은 최신 guard를 지키며 버린다', () => {
  const session = new ImeSession();
  session.start();
  session.update('가');
  session.finish('가', '가');
  session.start();
  session.update('나');
  session.finish('나', '나');

  assert.equal(session.consumeTrailingInput({
    inputType: 'insertFromComposition',
    data: '가',
    isComposing: false,
    value: '가',
  }), true);
  assert.equal(session.consumeTrailingInput({
    inputType: 'insertFromComposition',
    data: '나',
    isComposing: false,
    value: '나',
  }), true);
});

test('일반 입력은 오래된 커밋 후보를 끝내고 그대로 통과한다', () => {
  const session = new ImeSession();
  session.start();
  session.update('한');
  session.finish('한', '한');

  assert.equal(session.consumeTrailingInput({
    inputType: 'insertText',
    data: 'A',
    isComposing: false,
    value: 'A',
  }), false);
  assert.equal(session.consumeTrailingInput({
    inputType: 'insertFromComposition',
    data: '한',
    isComposing: false,
    value: '한',
  }), false);
});
