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
  assert.match(html, /<h1 class="visually-hidden">rhwp-studio 문서 편집기<\/h1>/);
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

test('숨겨진 편집 입력과 글자색 입력은 접근 가능한 이름을 제공한다', () => {
  const html = source('index.html');
  const inputHandler = source('src/engine/input-handler.ts');

  assert.match(html, /id="text-color-picker"[^>]*aria-label="글자 색 선택"/);
  assert.match(inputHandler, /setAttribute\('aria-label', '문서 편집 입력'\)/);
  assert.match(inputHandler, /this\.container\.closest\('main'\)/);
});

test('문서 렌더링 이미지와 스크롤 영역은 보조 기술 및 키보드 계약을 제공한다', () => {
  const html = source('index.html');
  const pageRenderer = source('src/view/page-renderer.ts');

  assert.match(
    html,
    /<div id="scroll-container" role="region" aria-label="문서 페이지" tabindex="0">/,
  );
  assert.match(pageRenderer, /const element = new Image\(\);\s*element\.alt = '';/);
});

test('문서가 없을 때 파일 열기와 드롭 위치를 명확히 표시한다', () => {
  const html = source('index.html');
  const main = source('src/main.ts');

  assert.match(html, /id="document-empty-state"/);
  assert.match(html, /HWP, HWPX, HML 파일을 선택하거나 여기에 놓으세요\./);
  assert.match(html, /id="document-open-action">HWP\/HWPX 열기<\/button>/);
  assert.match(html, /id="document-new-action">새 파일<\/button>/);
  assert.match(main, /document-open-action/);
  assert.match(main, /document-new-action/);
  assert.match(main, /dispatcher\.dispatch\('file:open'\)/);
  assert.match(main, /dispatcher\.dispatch\('file:new-doc'\)/);
  assert.match(main, /emptyState\.hidden = true/);
});

test('서식 도구 모음 컨트롤은 테마 토큰으로 전경색과 배경색을 명시한다', () => {
  const css = source('src/styles/style-bar.css');

  assert.match(css, /\.sb-size\s*\{[\s\S]*?color:\s*var\(--color-text\);[\s\S]*?background:\s*var\(--color-surface\);/);
  assert.match(css, /\.sb-combo\s*\{[\s\S]*?background:\s*var\(--color-surface\);[\s\S]*?color:\s*var\(--color-text\);/);
});
