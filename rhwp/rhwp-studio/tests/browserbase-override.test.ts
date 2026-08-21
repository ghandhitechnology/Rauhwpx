import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BROWSERBASE_OVERRIDE_STORAGE_KEY,
  buildBrowserbaseOverride,
  clearBrowserbaseOverride,
  loadBrowserbaseOverride,
  saveBrowserbaseOverride,
} from '../src/agent/browserbase-override.ts';

function memoryStore() {
  const map = new Map<string, string>();
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => { map.set(key, value); },
    removeItem: (key: string) => { map.delete(key); },
    map,
  };
}

test('입력 칸 값은 다듬어 보내고, 키가 비면 덮어쓰기가 아니다', () => {
  assert.equal(buildBrowserbaseOverride({ apiKey: '   ', projectId: 'p' }), null);
  assert.deepEqual(
    buildBrowserbaseOverride({ apiKey: ' bb_live_x ', projectId: '', geminiApiKey: ' g ' }),
    { apiKey: 'bb_live_x', geminiApiKey: 'g' },
  );
});

test('덮어쓰기는 탭 보관소에 저장·복원·삭제된다', () => {
  const store = memoryStore();
  assert.equal(loadBrowserbaseOverride(store), null);
  saveBrowserbaseOverride({ apiKey: 'bb_live_x', projectId: 'proj-a' }, store);
  assert.ok(store.map.has(BROWSERBASE_OVERRIDE_STORAGE_KEY));
  assert.deepEqual(loadBrowserbaseOverride(store), { apiKey: 'bb_live_x', projectId: 'proj-a' });
  store.setItem(BROWSERBASE_OVERRIDE_STORAGE_KEY, '{"projectId":"orphan"}');
  assert.equal(loadBrowserbaseOverride(store), null, '키 없는 기록은 버린다');
  store.setItem(BROWSERBASE_OVERRIDE_STORAGE_KEY, 'not json');
  assert.equal(loadBrowserbaseOverride(store), null);
  clearBrowserbaseOverride(store);
  assert.equal(store.map.size, 0);
  assert.equal(loadBrowserbaseOverride(null), null);
});
