import assert from 'node:assert/strict';
import test from 'node:test';
import type { CompareDocumentSnapshot } from '../src/compare/types.ts';
import {
  clearHistory,
  getHistoryPayload,
  saveHistoryIrSnapshot,
} from '../src/history/idb-store.ts';

test('memory history stores serialized snapshots without sharing caller objects', async () => {
  await clearHistory();
  const snapshot: CompareDocumentSnapshot = {
    meta: { name: '긴 문서😀', sectionCount: 1, pageCount: 1 },
    paragraphs: [{
      section: 0,
      paragraph: 0,
      sectionPage: 1,
      globalIndex: 0,
      stableId: 'stable-1',
      text: '원본 텍스트😀',
      normalizedText: '원본 텍스트😀',
      controlCount: 0,
      signature: 'signature',
      isAnchorCandidate: true,
    }],
    controls: [],
  };
  const expectedJson = JSON.stringify(snapshot);
  const saved = await saveHistoryIrSnapshot('메모리', 'long.hwpx', snapshot);

  snapshot.paragraphs[0].text = '호출자가 변경한 텍스트';
  const payload = await getHistoryPayload(saved.id);

  assert.equal(saved.byteLength, Buffer.byteLength(expectedJson, 'utf8'));
  assert.equal(payload?.kind, 'ir');
  if (payload?.kind === 'ir') {
    assert.equal(payload.snapshot.paragraphs[0].text, '원본 텍스트😀');
    assert.notEqual(payload.snapshot, snapshot);
  }
  await clearHistory();
});
