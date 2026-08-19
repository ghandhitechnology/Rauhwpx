import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const calibration = readFileSync(
  new URL('../src/ui/agent-sidebar/writing-style-calibration.ts', import.meta.url),
  'utf8',
);
const css = readFileSync(
  new URL('../src/ui/agent-sidebar/writing-style-calibration.css', import.meta.url),
  'utf8',
);
const bridge = readFileSync(new URL('../src/agent/bridge.ts', import.meta.url), 'utf8');
const types = readFileSync(new URL('../src/agent/types.ts', import.meta.url), 'utf8');

test('calibration uses the live provider catalog with the shared model registry fallback', () => {
  // 보정 런타임은 허브 쪽 codex/claude/pi 뿐이다 — grok/cursor 는 목록에 세우지 않는다.
  assert.match(calibration, /const AGENTS:[^=]+= \['claude', 'codex', 'pi'\]/);
  assert.doesNotMatch(calibration, /const AGENTS:[^=]+= \[[^\]]*'(grok|cursor)'/);
  // 라벨 표는 공용 모듈 하나만 본다 — 화면마다 베끼면 프로바이더가 조용히 빠진다.
  assert.match(calibration, /import \{ AGENT_LABEL \} from '\.\/providers\.ts'/);
  assert.doesNotMatch(calibration, /const AGENT_LABEL/);
  // 카탈로그에 없는 프로바이더가 기본값으로 저장돼 있어도 쓸 수 있는 쪽으로 옮긴다.
  assert.match(calibration, /if \(calibrationCatalog\) return \{ available: false/);
  assert.match(calibration, /const fallback = AGENTS\.find\(\(agent\) => providerAvailability\(agent\)\.available\)/);
  assert.match(css, /grid-template-columns: repeat\(3, 1fr\)/);
  assert.match(calibration, /bridge\.requestWritingStyleCatalog\(\)/);
  assert.match(calibration, /bridge\.requestProviderStatus\(\)/);
  assert.match(calibration, /bridge\.requestPiStatus\(\)/);
  assert.match(calibration, /calibrationCatalog\?\.providers\.find/);
  assert.match(calibration, /modelsForAgent\(agent\)\.map/);
  assert.match(calibration, /button\.disabled = !health\.available/);
  assert.match(calibration, /설정의 Pi 연결/);
  assert.match(calibration, /if \(!selectionTouched && event\.catalog\.defaultSelection\)/);
  assert.match(calibration, /entry\.id === selection\.agent && entry\.available/);
  assert.match(calibration, /provider\?\.models\.some\(\(model\) => model\.id === selection\.model\)/);
  assert.doesNotMatch(calibration, /!selectionTouched && activeAgent && event\.catalog\.defaultSelection/);
  assert.match(types, /export interface WritingStyleCatalog/);
  assert.match(bridge, /type: 'writing-style-catalog-request'/);
});

test('calibration request carries model identity and additive corpus intent', () => {
  assert.match(calibration, /bridge\.calibrateWritingStyle\(\{ language, files, agent: selectedAgent, model: selectedModel, append:/);
  assert.match(calibration, /'append', '문서 추가'/);
  assert.match(calibration, /'replace', '전체 교체'/);
  assert.match(calibration, /status\?\.sources/);
  assert.match(calibration, /savedSourceCount/);
  assert.match(calibration, /function storedCorpusCount/);
  assert.match(calibration, /function displayCorpusCount/);
  assert.match(calibration, /return storedCorpusCount\(status\) \|\| status\.sourceCount/);
  assert.match(calibration, /activeStatus\?\.active === true && storedCorpusCount\(activeStatus\) > 0/);
  assert.match(calibration, /저장된 원본은 없습니다/);
  assert.match(calibration, /새 문서로 교체/);
  assert.match(types, /sources\?: WritingStyleSource\[\]/);
});

test('long analysis has server-authored activity without a browser deadline', () => {
  assert.doesNotMatch(calibration, /ANALYSIS_TIMEOUT_MS|analysisTimer/);
  assert.match(calibration, /if \(!requestId\) \{/);
  assert.match(calibration, /requestId = event\.requestId/);
  assert.match(calibration, /event\.elapsedMs/);
  assert.match(calibration, /calibrationBaselineUpdatedAt = activeStatus\?\.updatedAt \?\? null/);
  assert.match(calibration, /event\.status\.updatedAt !== calibrationBaselineUpdatedAt/);
  assert.match(calibration, /&& awaitingReconnectCompletion/);
  assert.match(calibration, /typeof progress\.completed === 'number'/);
  assert.match(calibration, /typeof progress\.total === 'number'/);
  assert.match(calibration, /aria-live/);
  assert.doesNotMatch(calibration, /chain-of-thought|reasoning trace|추론 과정/i);
});

test('knowledge-network progress is bounded, accessible, and reduced-motion safe', () => {
  assert.match(calibration, /createKnowledgeNetwork/);
  assert.match(calibration, /aria-label', '문서의 표현 관계가 지식 지도로 연결되는 모습'/);
  assert.match(css, /\.ag-calibration-network-edge\.ag-live/);
  assert.match(css, /\.ag-calibration-network-node\.ag-live/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(css, /\.ag-calibration-network-scape\.ag-paused/);
  assert.doesNotMatch(css, /linear-gradient|radial-gradient|backdrop-filter/);
});
