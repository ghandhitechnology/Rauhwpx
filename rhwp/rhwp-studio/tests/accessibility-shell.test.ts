import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));

function source(path: string): string {
  return readFileSync(join(rootDir, path), 'utf8');
}

test('편집기 셸은 제목과 header, main, footer landmark를 제공한다', () => {
  const html = source('index.html');

  assert.match(html, /<header id="studio-header">/);
  assert.match(html, /<h1 class="visually-hidden">Rauhwpx 문서 편집기<\/h1>/);
  assert.match(html, /<nav id="menu-bar" aria-label="주 메뉴">/);
  assert.match(html, /<main id="editor-area" aria-label="문서 편집 영역">/);
  assert.match(html, /<footer id="status-bar">/);
});

test('서식 도구 모음의 폼 컨트롤은 접근 가능한 이름을 제공한다', () => {
  const html = source('index.html');

  for (const [id, label] of [
    ['style-name', '스타일'],
    ['font-lang', '언어'],
    ['font-name', '글꼴'],
    ['font-size', '크기'],
    ['linespacing-select', '줄 간격'],
  ]) {
    assert.match(
      html,
      new RegExp(`id="${id}"[^>]*aria-label="${label}"|aria-label="${label}"[^>]*id="${id}"`),
    );
  }
});
