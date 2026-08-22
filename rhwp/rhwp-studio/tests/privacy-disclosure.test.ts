import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { defaultAgentPrefs } from '../src/agent/agent-prefs.ts';
import { defaultModelForAgent } from '../src/agent/models.ts';
import type { AgentName } from '../src/agent/types.ts';
import {
  PRIVACY_LIMIT_DISCLAIMER,
  PRIVACY_NO_SILENT_UPLOAD,
  buildPrivacyDisclosure,
  credentialTargetFor,
  forbiddenPrivacyClaim,
  privacyDisclosureText,
  type PrivacySnapshot,
} from '../src/core/privacy-disclosure.ts';

const AGENTS: readonly AgentName[] = ['claude', 'codex', 'grok', 'cursor', 'pi'];

function snapshot(partial: Partial<PrivacySnapshot> = {}): PrivacySnapshot {
  const prefs = defaultAgentPrefs();
  return {
    shell: 'desktop',
    location: {
      hasDocument: true,
      fileName: '보고.hwp',
      isUntitled: false,
      sourcePath: 'C:\\Users\\office\\보고.hwp',
    },
    defaultAgent: prefs.defaultAgent,
    defaultModel: prefs.defaultModel,
    ...partial,
  };
}

function textFor(partial: Partial<PrivacySnapshot> = {}): string {
  return privacyDisclosureText(buildPrivacyDisclosure(snapshot(partial)));
}

test('안내는 파일 위치·로컬 한글 처리·고른 CLI·토큰 행선을 말한다', () => {
  const disclosure = buildPrivacyDisclosure(snapshot());
  const ids = disclosure.sections.map((section) => section.id);
  assert.deepEqual(ids, ['file', 'hangul', 'provider', 'credentials', 'upload', 'limit']);
  const text = privacyDisclosureText(disclosure);
  assert.match(text, /이 컴퓨터 디스크에 있습니다/);
  assert.match(text, /C:\\Users\\office\\보고\.hwp/);
  assert.match(text, /WASM 엔진/);
  assert.match(text, /한컴 서버나 Rauhwpx 클라우드로 원본 파일을 보내지 않습니다/);
  assert.match(text, /기본 제공자는 Codex입니다/);
  assert.match(text, /그 CLI가 쓰는 값입니다/);
  assert.match(text, /Codex CLI/);
  assert.match(text, /OpenAI/);
  assert.match(text, /OPENAI_API_KEY/);
  assert.match(text, /OS 자격 증명 저장소/);
  assert.match(text, /127\.0\.0\.1/);
  assert.match(text, /로컬 라우터/);
  assert.ok(text.includes(PRIVACY_NO_SILENT_UPLOAD));
  assert.ok(text.includes(PRIVACY_LIMIT_DISCLAIMER));
});

test('브라우저 문서는 WASM 편집기에 있고 디스크 경로를 지어내지 않는다', () => {
  const text = textFor({
    shell: 'browser',
    location: {
      hasDocument: true,
      fileName: '회의록.hwpx',
      isUntitled: false,
      sourcePath: null,
    },
  });
  assert.match(text, /브라우저의 로컬 WASM 편집기/);
  assert.match(text, /회의록\.hwpx/);
  assert.doesNotMatch(text, /이 컴퓨터 디스크에 있습니다/);
  assert.match(text, /localhost 에이전트 허브/);
});

test('새 문서와 빈 창은 이 기기 메모리만 말한다', () => {
  const untitled = textFor({
    location: { hasDocument: true, fileName: '새 문서.hwp', isUntitled: true, sourcePath: null },
  });
  assert.match(untitled, /아직 저장하지 않은 문서/);
  assert.match(untitled, /편집기 메모리에만 있습니다/);

  const empty = textFor({
    location: { hasDocument: false, fileName: '', isUntitled: false, sourcePath: null },
  });
  assert.match(empty, /지금 열린 문서가 없습니다/);
});

test('모든 제공자의 토큰은 그 CLI와 네트워크 상대를 가리킨다', () => {
  const expected: Record<AgentName, { cli: string; target: string; env: string | null }> = {
    claude: { cli: 'Claude CLI', target: 'Anthropic', env: 'ANTHROPIC_API_KEY' },
    codex: { cli: 'Codex CLI', target: 'OpenAI', env: 'OPENAI_API_KEY' },
    grok: { cli: 'Grok CLI', target: 'xAI', env: 'XAI_API_KEY' },
    cursor: { cli: 'Cursor CLI', target: 'Cursor', env: 'CURSOR_API_KEY' },
    pi: { cli: 'Pi', target: 'OpenRouter', env: null },
  };
  for (const agent of AGENTS) {
    const target = credentialTargetFor(agent);
    assert.equal(target.cliLabel, expected[agent].cli);
    assert.equal(target.networkTarget, expected[agent].target);
    assert.equal(target.envName, expected[agent].env);
    const text = textFor({
      defaultAgent: agent,
      defaultModel: defaultModelForAgent(agent),
    });
    assert.match(text, new RegExp(target.cliLabel));
    assert.match(text, new RegExp(target.networkTarget));
    if (target.envName) assert.match(text, new RegExp(target.envName));
    else assert.match(text, /OpenRouter 키/);
    assert.equal(forbiddenPrivacyClaim(text), null);
  }
});

test('현재 대화 제공자가 기본값과 다르면 둘 다 밝힌다', () => {
  const text = textFor({
    defaultAgent: 'codex',
    defaultModel: defaultModelForAgent('codex'),
    conversationAgent: 'claude',
    conversationModel: 'sonnet',
  });
  assert.match(text, /기본 제공자는 Codex입니다/);
  assert.match(text, /이 대화는 Claude \/ Sonnet 5을 씁니다/);
});

test('안내는 에어갭·완전 오프라인 AI를 주장하지 않는다', () => {
  const text = textFor();
  assert.equal(forbiddenPrivacyClaim(text), null);
  assert.doesNotMatch(text, /에어갭/);
  assert.doesNotMatch(text, /air[\s-]?gap/i);
  assert.doesNotMatch(text, /fully offline/i);
  assert.doesNotMatch(text, /문서 클라우드 파이프라인은 있습니다/);
  assert.match(text, /문서 클라우드 파이프라인은 없습니다/);
  assert.match(text, /도구로 읽은 문서 일부/);
  assert.match(text, /Browserbase/);
});

test('환경 설정과 사이드바 설정이 같은 안내 모듈을 쓴다', () => {
  const options = readFileSync(new URL('../src/ui/options-dialog.ts', import.meta.url), 'utf8');
  const settings = readFileSync(new URL('../src/ui/agent-sidebar/settings.ts', import.meta.url), 'utf8');
  const sidebar = readFileSync(new URL('../src/ui/agent-sidebar/index.ts', import.meta.url), 'utf8');
  const tool = readFileSync(new URL('../src/command/commands/tool.ts', import.meta.url), 'utf8');
  assert.match(options, /dataset\.tab = 'security'/);
  assert.match(options, /textContent = '보안'/);
  assert.match(options, /createSecurityPanel/);
  assert.match(options, /renderPrivacySnapshot/);
  assert.match(tool, /getNativeFileSourcePath\(services\.wasm\.currentFileHandle\)/);
  assert.match(settings, /createSection\('보안·개인정보'\)/);
  assert.match(settings, /renderPrivacySnapshot/);
  assert.match(sidebar, /getDocumentLocation:/);
});
