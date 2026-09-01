import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const ruler = readFileSync(new URL('../src/view/ruler.ts', import.meta.url), 'utf8');

// #6187: resize 가 bitmap을 먼저 지운 뒤 다음 프레임에 paint 하면 눈금자가 한 프레임
// 공백이 된다. 크기 동기와 두 축 paint 는 같은 update() 안에서 일어나야 한다.
// 핀 드래그 입력 계약은 이 포크에 핀 기하가 없어 이식하지 않는다.

test('viewport-resize는 즉시 bitmap을 지우지 않고 다음 paint로 미룬다', () => {
  assert.match(
    ruler,
    /eventBus\.on\('viewport-resize',\s*\(\) => this\.scheduleUpdate\(\)\)/,
    'resize 이벤트에서 canvas.width 대입은 한 프레임 공백을 만든다',
  );
  assert.doesNotMatch(
    ruler,
    /viewport-resize',\s*\(\) => \{ this\.resize\(\)/,
    'viewport-resize 가 resize()를 직접 부르면 bitmap이 먼저 지워진다',
  );
});

test('update는 크기 동기 직후 가로·세로를 같은 턴에 그린다', () => {
  assert.match(ruler, /private syncCanvasSize\(dpr: number\): void/);
  const updateStart = ruler.indexOf('  update(): void {');
  assert.notEqual(updateStart, -1, 'update() 필요');
  const updateEnd = ruler.indexOf('\n  /**', updateStart + 1);
  const body = ruler.slice(updateStart, updateEnd === -1 ? undefined : updateEnd);
  assert.match(body, /this\.syncCanvasSize\(dpr\)/);
  assert.match(body, /this\.drawHorizontal\(\)/);
  assert.match(body, /this\.drawVertical\(\)/);
  assert.ok(
    body.indexOf('syncCanvasSize') < body.indexOf('drawHorizontal')
      && body.indexOf('drawHorizontal') < body.indexOf('drawVertical'),
    '크기 동기 → 가로 그리기 → 세로 그리기 순서',
  );
});

test('같은 width/height 재대입으로 bitmap을 지우지 않는다', () => {
  assert.match(ruler, /if \(this\.hCanvas\.width !== hWidth\) this\.hCanvas\.width = hWidth/);
  assert.match(ruler, /if \(this\.vCanvas\.height !== vHeight\) this\.vCanvas\.height = vHeight/);
});
