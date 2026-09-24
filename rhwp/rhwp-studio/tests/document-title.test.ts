import test from 'node:test';
import assert from 'node:assert/strict';
import { installDocumentTitle } from '../src/ui/document-title.ts';

test('파일명과 설치형 표시 모드 전환에 맞춰 제목을 갱신한다', () => {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const media = new EventTarget() as EventTarget & { matches: boolean };
  media.matches = false;
  const visibleTitle = { textContent: '', title: '', hidden: true };
  const pageDocument = {
    title: 'Rauhwpx',
    getElementById: (id: string) => id === 'editor-document-title' ? visibleTitle : null,
  };
  let loaded = false;
  const bridge = {
    fileName: 'document.hwp',
    hasLoadedDocument: () => loaded,
    onFileNameChanged: undefined as ((fileName: string) => void) | undefined,
  };
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { matchMedia: () => media } });
  Object.defineProperty(globalThis, 'document', { configurable: true, value: pageDocument });
  try {
    installDocumentTitle(bridge);
    assert.equal(pageDocument.title, 'Rauhwpx', '문서 없는 상태는 기본 제목');
    assert.equal(visibleTitle.hidden, true);
    loaded = true;
    bridge.fileName = '검토 <원본> & 001.hwp';
    bridge.onFileNameChanged?.(bridge.fileName);
    assert.equal(pageDocument.title, '검토 <원본> & 001.hwp - Rauhwpx');
    assert.equal(visibleTitle.textContent, bridge.fileName);
    assert.equal(visibleTitle.title, bridge.fileName);
    assert.equal(visibleTitle.hidden, false);
    media.matches = true;
    media.dispatchEvent(new Event('change'));
    assert.equal(pageDocument.title, '검토 <원본> & 001.hwp', '설치형 창은 앱 이름 중복을 피한다');
    bridge.fileName = '저장.hwpx';
    bridge.onFileNameChanged?.(bridge.fileName);
    assert.equal(pageDocument.title, '저장.hwpx');
    assert.equal(visibleTitle.textContent, '저장.hwpx');
    media.matches = false;
    media.dispatchEvent(new Event('change'));
    assert.equal(pageDocument.title, '저장.hwpx - Rauhwpx');
    loaded = false;
    bridge.onFileNameChanged?.(bridge.fileName);
    assert.equal(pageDocument.title, 'Rauhwpx', '문서가 없으면 파일명과 무관하게 기본 제목');
    assert.equal(visibleTitle.hidden, true);
    assert.equal(visibleTitle.textContent, '');
  } finally {
    for (const [key, descriptor] of [['window', originalWindow], ['document', originalDocument]] as const) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
