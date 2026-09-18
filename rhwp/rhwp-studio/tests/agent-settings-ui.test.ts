import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
// settings.ts 는 CSS 를 가져오므로 Node 에서 불러올 수 없다 — 계기판 숫자
// 규칙만 css 없는 모듈에서 실제로 검증하고, DOM 계약은 소스 텍스트로 본다.
import { formatRelativeTime, formatResetAt, formatTokens, formatUsageAge, formatUsageReset } from '../src/ui/agent-sidebar/usage-format.ts';
// providers.ts 는 CSS 를 안 가져오므로 표를 텍스트가 아니라 값으로 직접 본다.
import { AGENT_LABEL, MASK_ICON_AGENTS, PROVIDER_ICON_SRC, PROVIDER_ORDER } from '../src/ui/agent-sidebar/providers.ts';

const readSource = (relativePath: string) => readFileSync(
  new URL(relativePath, import.meta.url),
  'utf8',
).replace(/\r\n/g, '\n');
const openCodeIcon = readSource('../public/icons/provider-opencode.svg');

test('토큰·시각 표기는 짧게 (폭이 흔들리지 않게)', () => {
  assert.equal(formatTokens(980), '980');
  assert.equal(formatTokens(340_000), '340K');
  assert.equal(formatTokens(1_240_000), '1.2M');
  const now = Date.now();
  assert.equal(formatRelativeTime(now, now), '방금');
  assert.equal(formatRelativeTime(now - 5 * 60_000, now), '5분 전');
  assert.equal(formatRelativeTime(now - 3 * 3_600_000, now), '3시간 전');
  assert.equal(formatRelativeTime(now - 50 * 3_600_000, now), '2일 전');
  assert.equal(formatResetAt(now + 5 * 60_000, now), '5분 후 리셋');
  assert.equal(formatResetAt(now + 3 * 3_600_000, now), '3시간 후 리셋');
  assert.equal(formatResetAt(now - 1_000, now), '곧 리셋');
  assert.equal(formatUsageAge(now - 5 * 60_000, now), '5m ago');
  assert.equal(formatUsageAge(now - 3 * 3_600_000, now), '3h ago');
  assert.equal(formatUsageReset(now + 5 * 60_000, now), 'Resets in 5m');
  assert.equal(formatUsageReset(now + 3 * 3_600_000, now), 'Resets in 3h');
});

test('Grok · Cursor · OpenCode는 프로바이더 목록 · 라벨 · 아이콘 · 강조색을 모두 갖춘다', () => {
  // 연결 목록과 입력기 피커는 일곱 프로바이더를 같은 순서로 세운다.
  assert.deepEqual([...PROVIDER_ORDER], ['rau', 'claude', 'codex', 'pi', 'grok', 'cursor', 'opencode']);
  assert.equal(AGENT_LABEL.rau, 'Rau');
  assert.equal(AGENT_LABEL.grok, 'Grok');
  assert.equal(AGENT_LABEL.cursor, 'Cursor');
  assert.equal(AGENT_LABEL.opencode, 'OpenCode');
  // 단색 로고는 마스크로 그리므로 마스크 목록이 전체 프로바이더를 덮어야 한다.
  assert.deepEqual([...MASK_ICON_AGENTS], ['rau', 'codex', 'pi', 'grok', 'cursor', 'opencode']);
  // 마스크가 아닌 프로바이더만 이미지 경로를 갖는다.
  assert.equal(PROVIDER_ICON_SRC.claude, '/icons/provider-claude.png');
  assert.equal(PROVIDER_ICON_SRC.grok, undefined);
  assert.equal(PROVIDER_ICON_SRC.cursor, undefined);
  assert.equal(PROVIDER_ICON_SRC.opencode, undefined);
  // 배송되는 아이콘 에셋은 외부 참조 없이 자체 완결이어야 한다.
  assert.match(openCodeIcon, /^<svg[^>]+viewBox="0 0 512 512"/);
  assert.match(openCodeIcon, /fill-rule="evenodd"/);
  assert.doesNotMatch(openCodeIcon, /(?:href|src)=["']https?:|data:/);
});

test('Rau 는 프로바이더 목록 맨 앞이다', () => {
  assert.equal(PROVIDER_ORDER[0], 'rau');
});
