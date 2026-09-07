import test from 'node:test';
import assert from 'node:assert/strict';

import { defaultShortcuts, matchShortcut } from '../src/command/shortcut-map.ts';

function key(input: Partial<KeyboardEvent>): KeyboardEvent {
  return {
    key: input.key ?? '',
    code: input.code ?? '',
    shiftKey: input.shiftKey ?? false,
    ctrlKey: input.ctrlKey ?? false,
    metaKey: input.metaKey ?? false,
    altKey: input.altKey ?? false,
  } as KeyboardEvent;
}

function command(input: Partial<KeyboardEvent>, platform: 'mac' | 'other' = 'other'): string | null {
  return matchShortcut(key(input), defaultShortcuts, platform);
}

test('한컴 호환 장평 단축키를 영문 키로 매핑한다', () => {
  assert.equal(command({ key: 'j', code: 'KeyJ', altKey: true, shiftKey: true }), 'format:char-ratio-decrease');
  assert.equal(command({ key: 'k', code: 'KeyK', altKey: true, shiftKey: true }), 'format:char-ratio-increase');
});

test('한컴 호환 자간 단축키를 영문 키로 매핑한다', () => {
  assert.equal(command({ key: 'n', code: 'KeyN', altKey: true, shiftKey: true }), 'format:char-spacing-decrease');
  assert.equal(command({ key: 'w', code: 'KeyW', altKey: true, shiftKey: true }), 'format:char-spacing-increase');
});

test('한글 입력 모드 장평/자간 단축키를 매핑한다', () => {
  assert.equal(command({ key: 'ㅓ', altKey: true, shiftKey: true }), 'format:char-ratio-decrease');
  assert.equal(command({ key: 'ㅏ', altKey: true, shiftKey: true }), 'format:char-ratio-increase');
  assert.equal(command({ key: 'ㅜ', altKey: true, shiftKey: true }), 'format:char-spacing-decrease');
  assert.equal(command({ key: 'ㅈ', altKey: true, shiftKey: true }), 'format:char-spacing-increase');
});

test('IME pending 상태처럼 key가 Process여도 code로 장평/자간 단축키를 판별한다', () => {
  assert.equal(command({ key: 'Process', code: 'KeyJ', altKey: true, shiftKey: true }), 'format:char-ratio-decrease');
  assert.equal(command({ key: 'Process', code: 'KeyK', altKey: true, shiftKey: true }), 'format:char-ratio-increase');
  assert.equal(command({ key: 'Process', code: 'KeyN', altKey: true, shiftKey: true }), 'format:char-spacing-decrease');
  assert.equal(command({ key: 'Process', code: 'KeyW', altKey: true, shiftKey: true }), 'format:char-spacing-increase');
});

test('표 줄/칸 추가·지우기 단축키는 대화상자 명령으로 매핑한다', () => {
  assert.equal(command({ key: 'Enter', altKey: true }, 'mac'), 'table:insert-row-col');
  assert.equal(command({ key: 'enter', altKey: true }, 'mac'), 'table:insert-row-col');
  assert.equal(command({ key: 'Enter', altKey: true }, 'other'), 'table:insert-row-col');
  assert.equal(command({ key: 'enter', altKey: true }, 'other'), 'table:insert-row-col');
  assert.equal(command({ key: 'Insert', altKey: true }, 'mac'), null);
  assert.equal(command({ key: 'Help', altKey: true }, 'mac'), null);
  assert.equal(command({ key: 'Insert', altKey: true }, 'other'), null);
  assert.equal(command({ key: 'insert', altKey: true }, 'other'), null);
  assert.equal(command({ key: 'Help', altKey: true }, 'other'), null);
  assert.equal(command({ key: 'Process', code: 'Insert', altKey: true }, 'other'), null);
  assert.equal(command({ key: 'Process', code: 'Help', altKey: true }, 'other'), null);
  assert.equal(command({ key: 'Delete', altKey: true }), 'table:delete-row-col');
  assert.equal(command({ key: 'delete', altKey: true }), 'table:delete-row-col');
});

test('기본 문자 단축키는 한글 IME Process와 macOS Option 변환에서도 동작한다', () => {
  for (const [key, code, cmd] of [
    ['ㅠ', 'KeyB', 'format:bold'], ['ㅑ', 'KeyI', 'format:italic'],
    ['ㅕ', 'KeyU', 'format:underline'], ['ㅋ', 'KeyZ', 'edit:undo'],
    ['ㄴ', 'KeyS', 'file:save'], ['ㄹ', 'KeyF', 'edit:find'],
  ]) {
    assert.equal(command({ key, code, ctrlKey: true }), cmd);
    assert.equal(command({ key: 'Process', code, metaKey: true }), cmd);
  }
  assert.equal(command({ key: '˜', code: 'KeyN', altKey: true }, 'mac'), 'file:new-doc');
  assert.equal(command({ key: 'Dead', code: 'KeyL', altKey: true }, 'mac'), 'format:char-shape');
  assert.equal(command({ key: '‰', code: 'KeyR', altKey: true, shiftKey: true }, 'mac'), 'format:font-size-decrease');
});

test('대체 영문 배열과 수정자 없는 입력을 보존한다', () => {
  assert.equal(command({ key: 'z', code: 'KeyY', ctrlKey: true }), 'edit:undo');
  assert.equal(command({ key: 'q', code: 'KeyB', ctrlKey: true }), null);
  assert.equal(command({ key: 'ㅠ', code: 'KeyB' }), null);
  assert.equal(command({ key: 'Process', code: 'KeyB' }), null);
  assert.equal(command({ key: '+', code: 'Equal', ctrlKey: true, shiftKey: true }), 'view:zoom-in');
});


test('AltGr 문자 입력은 Ctrl+Alt 서식 단축키로 처리하지 않는다', () => {
  const event = key({ key: 'ą', code: 'KeyA', ctrlKey: true, altKey: true });
  event.getModifierState = (modifier: string) => modifier === 'AltGraph';
  assert.equal(matchShortcut(event, defaultShortcuts), null);
});
