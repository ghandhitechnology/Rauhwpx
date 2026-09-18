import test from 'node:test';
import assert from 'node:assert/strict';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTestModuleServer } from './support/module-server.ts';

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));

test('#6453 HF 커서 위치 API는 대표 편집 페이지를 바꾸지 않는다', async () => {
  const vite = await createTestModuleServer(rootDir);
  try {
    const { CursorState } = await vite.ssrLoadModule('/src/engine/cursor.ts');
    const wasm = {
      getHeaderFooterPreviewPage: () => 2,
      getCursorRectInHeaderFooter: (
        _sec: number, _header: boolean, _apply: number,
        paraIdx: number, charOffset: number, previewPage: number,
      ) => ({ pageIndex: previewPage, x: charOffset * 8, y: paraIdx * 20, height: 12 }),
      getHeaderFooterParaInfo: () => JSON.stringify({ paraCount: 1, charCount: 8 }),
    };
    const cursor: any = new CursorState(wasm);

    cursor.enterHeaderFooterMode(true, 0, 1, 9);
    assert.equal(cursor.hfPreviewPage, 2, '진입 쪽과 무관하게 구역 대표 페이지를 사용한다');

    cursor.setHfCursorPosition(0, 4);
    assert.equal(cursor.hfPreviewPage, 2, '텍스트 위치 변경은 대표 페이지를 바꾸지 않는다');

    assert.equal(cursor.selectHeaderFooterRange(
      { sectionIdx: 0, isHeader: true, applyTo: 1, paraIdx: 0, charOffset: 1 },
      { sectionIdx: 0, isHeader: true, applyTo: 1, paraIdx: 0, charOffset: 4 },
      9,
    ), true);
    assert.equal(cursor.getHeaderFooterSelectionOrdered()?.previewPage, 2,
      'history의 이전 페이지 힌트도 현재 대표 페이지로 정규화한다');
  } finally {
    await vite.close();
  }
});
