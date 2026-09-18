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
const source = readSource('../src/ui/agent-sidebar/index.ts');
const settings = readSource('../src/ui/agent-sidebar/settings.ts');
const bridgeSource = readSource('../src/agent/bridge.ts');
const agentTypesSource = readSource('../src/agent/types.ts');
const editingSettings = readSource('../src/ui/agent-sidebar/settings-editing.ts');
const settingsCss = readSource('../src/ui/agent-sidebar/settings.css');
const css = readSource('../src/ui/agent-sidebar/agent-sidebar.css');
const buttonCss = readSource('../src/ui/agent-sidebar/sidebar-button-modern.css');
const openCodeIcon = readSource('../public/icons/provider-opencode.svg');
const icons = readSource('../src/ui/agent-sidebar/icons.ts');
const editCommandsSource = readSource('../src/command/commands/edit.ts');
const toolCommandsSource = readSource('../src/command/commands/tool.ts');
const mainSource = readSource('../src/main.ts');

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
  // 두 화면 모두 표를 다시 베끼지 않고 공용 모듈에서 가져다 쓴다.
  for (const consumer of [settings, source]) {
    assert.match(consumer, /import \{ AGENT_LABEL, createProviderIcon, PROVIDER_ORDER \} from '\.\/providers\.ts'/);
    assert.doesNotMatch(consumer, /const AGENT_LABEL|const MASK_ICON_AGENTS|const PROVIDER_ICON_SRC/);
  }
  assert.match(settings, /for \(const agent of PROVIDER_ORDER\)/);
  assert.match(source, /for \(const agent of PROVIDER_ORDER\)/);
  // cursor 표기는 언제나 "Cursor" 다.
  assert.doesNotMatch(settings, /'Cursor Agent'|'cursor-agent'/);
  // 단색 로고는 마스크로 그리므로 마스크 목록과 CSS 규칙이 함께 있어야 한다.
  assert.deepEqual([...MASK_ICON_AGENTS], ['rau', 'codex', 'pi', 'grok', 'cursor', 'opencode']);
  // 마스크가 아닌 프로바이더만 이미지 경로를 갖는다.
  assert.equal(PROVIDER_ICON_SRC.claude, '/icons/provider-claude.png');
  assert.equal(PROVIDER_ICON_SRC.grok, undefined);
  assert.equal(PROVIDER_ICON_SRC.cursor, undefined);
  assert.equal(PROVIDER_ICON_SRC.opencode, undefined);
  assert.match(css, /\.ag-provider-icon-mask\[data-agent='rau'\][\s\S]*?rau\.png/);
  assert.match(css, /\.ag-provider-icon-mask\[data-agent='grok'\][\s\S]*?provider-grok\.svg/);
  assert.match(css, /\.ag-provider-icon-mask\[data-agent='cursor'\][\s\S]*?provider-cursor\.svg/);
  assert.match(css, /\.ag-provider-icon-mask\[data-agent='opencode'\][\s\S]*?provider-opencode\.svg/);
  assert.match(openCodeIcon, /^<svg[^>]+viewBox="0 0 512 512"/);
  assert.match(openCodeIcon, /fill-rule="evenodd"/);
  assert.doesNotMatch(openCodeIcon, /(?:href|src)=["']https?:|data:/);
  // 강조색은 라이트/다크 팔레트에 모두 있고 data-agent 로 갈린다.
  assert.equal((css.match(/--ag-rau:/g) ?? []).length, 2);
  assert.equal((css.match(/--ag-grok:/g) ?? []).length, 2);
  assert.equal((css.match(/--ag-cursor:/g) ?? []).length, 2);
  assert.equal((css.match(/--ag-opencode:/g) ?? []).length, 2);
  assert.equal((css.match(/--ag-rau-wash:/g) ?? []).length, 2);
  assert.equal((css.match(/--ag-grok-wash:/g) ?? []).length, 2);
  assert.equal((css.match(/--ag-cursor-wash:/g) ?? []).length, 2);
  assert.equal((css.match(/--ag-opencode-wash:/g) ?? []).length, 2);
  assert.match(css, /\.ag-root\[data-agent='grok'\] \{\s*--ag-accent: var\(--ag-grok\);/);
  assert.match(css, /\.ag-root\[data-agent='cursor'\] \{\s*--ag-accent: var\(--ag-cursor\);/);
  assert.match(css, /\.ag-root\[data-agent='opencode'\] \{\s*--ag-accent: var\(--ag-opencode\);/);
  assert.match(css, /\.ag-plan-card\.ag-grok,\n\.ag-plan-card\.ag-cursor,\n\.ag-plan-card\.ag-opencode/);
  assert.match(css, /\.ag-review-card\.ag-grok,\n\.ag-review-card\.ag-cursor,\n\.ag-review-card\.ag-opencode/);
});

test('Rau 는 목록 맨 앞이고 공통 테두리 · 로그인 전용 설정 · $0 전송 잠금을 갖는다', () => {
  assert.equal(PROVIDER_ORDER[0], 'rau');
  assert.match(settingsCss, /\.ag-settings-provider-row\[open\]\s*\{[^}]*border-color:\s*var\(--ag-border\)/);
  assert.match(settings, /if \(agent === 'rau'\) \{\s*\n\s*if \(oauthTitle\) oauthTitle\.textContent = 'Rau로 시작'/);
  assert.match(settings, /setupApiToggle\.hidden = true/);
  assert.match(settings, /setupKeyBox\.hidden = true/);
  assert.match(settings, /로그아웃/);
  assert.match(source, /function rauCreditsEmpty\(\): boolean/);
  assert.match(source, /체험 크레딧이 다 됐어요\. 다른 모델을 연결해 주세요\./);
  assert.match(source, /case 'usage-report':\s*\n\s*lastUsage = e\.usage/);
  assert.match(source, /if \(!rauSetupComplete && lastUsage\?\.rau\)/);
  assert.match(source, /selectedAgent === 'rau' && !rauSetupComplete/);
  assert.ok(source.indexOf("return { ok: false, reason: 'Rau 연결을 먼저 완료해 주세요' }")
    < source.indexOf('const userMessage = recordUserMessage(prompt'));
  assert.ok(source.indexOf("return { ok: false, reason: '체험 크레딧이 다 됐어요. 다른 모델을 연결해 주세요.' }")
    < source.indexOf('const userMessage = recordUserMessage(prompt'));
});
