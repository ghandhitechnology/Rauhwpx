import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const cursorSource = readFileSync(new URL('../src/engine/cursor.ts', import.meta.url), 'utf8');
const mouseSource = readFileSync(
  new URL('../src/engine/input-handler-mouse.ts', import.meta.url),
  'utf8',
);
const inputSource = readFileSync(
  new URL('../src/engine/input-handler.ts', import.meta.url),
  'utf8',
);

test('#2400 pointer hit 좌표가 있으면 선행 경로 재조회를 수행하지 않는다', () => {
  const moveToHitBody = cursorSource.match(
    /moveToHit\(pos: DocumentPosition\): void \{([\s\S]*?)\n  \}/,
  )?.[1];

  assert.ok(moveToHitBody);
  assert.ok(moveToHitBody.indexOf('if (pos.cursorRect)') < moveToHitBody.indexOf('this.updateRect()'));
  assert.doesNotMatch(
    moveToHitBody.slice(0, moveToHitBody.indexOf('if (pos.cursorRect)')),
    /updateRect/,
  );
});
