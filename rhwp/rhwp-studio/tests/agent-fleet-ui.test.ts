import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

/* DOM 없이 편대 카드를 검증하는 최소 노드. 실제 Element 와 같은 형태만 흉내낸다. */
class FakeNode {
  tagName: string;
  className = '';
  attrs: Record<string, string> = {};
  children: FakeNode[] = [];
  listeners: Record<string, Array<() => void>> = {};
  hidden = false;
  disabled = false;
  type = '';
  own = '';
  classList: {
    add: (...names: string[]) => void;
    remove: (...names: string[]) => void;
    toggle: (name: string, force?: boolean) => boolean;
    contains: (name: string) => boolean;
  };

  constructor(tag: string) {
    this.tagName = tag.toUpperCase();
    const names = (): string[] => this.className.split(/\s+/).filter(Boolean);
    this.classList = {
      add: (...add: string[]) => {
        const set = new Set([...names(), ...add]);
        this.className = [...set].join(' ');
      },
      remove: (...drop: string[]) => {
        this.className = names().filter((name) => !drop.includes(name)).join(' ');
      },
      toggle: (name: string, force?: boolean) => {
        const on = force === undefined ? !names().includes(name) : force;
        if (on) this.classList.add(name);
        else this.classList.remove(name);
        return on;
      },
      contains: (name: string) => names().includes(name),
    };
  }

  get textContent(): string {
    if (this.children.length === 0) return this.own;
    return this.children.map((child) => child.textContent).join('');
  }

  set textContent(value: string) {
    this.children = [];
    this.own = value;
  }

  appendChild(child: FakeNode): FakeNode {
    this.children.push(child);
    return child;
  }

  append(...nodes: FakeNode[]): void {
    for (const node of nodes) this.children.push(node);
  }

  replaceChildren(...nodes: FakeNode[]): void {
    this.own = '';
    this.children = [...nodes];
  }

  setAttribute(name: string, value: string): void {
    this.attrs[name] = value;
  }

  getAttribute(name: string): string | null {
    return this.attrs[name] ?? null;
  }

  addEventListener(type: string, fn: () => void): void {
    (this.listeners[type] ??= []).push(fn);
  }

  click(): void {
    for (const fn of this.listeners['click'] ?? []) fn();
  }
}

const fakeDoc = {
  createElement: (tag: string) => new FakeNode(tag),
  createElementNS: (_ns: string, tag: string) => new FakeNode(tag),
};

// icons.ts / chevron.ts 는 전역 document 로 SVG 를 만든다.
(globalThis as Record<string, unknown>)['document'] = fakeDoc;

const { createSubagentFleet, isSpawnToolName, compactModelLabel, formatFleetClock } = await import(
  '../src/ui/agent-sidebar/subagent-fleet.ts'
);

function walk(node: FakeNode, out: FakeNode[] = []): FakeNode[] {
  out.push(node);
  for (const child of node.children) walk(child, out);
  return out;
}

function all(root: FakeNode, className: string): FakeNode[] {
  return walk(root).filter((node) => node.className.split(/\s+/).includes(className));
}

function one(root: FakeNode, className: string): FakeNode {
  const hit = all(root, className)[0];
  assert.ok(hit, `${className} 을 찾지 못했습니다`);
  return hit;
}

function mountFleet() {
  const mounted: FakeNode[] = [];
  const view = createSubagentFleet({
    doc: fakeDoc as unknown as Document,
    sessionModel: () => 'claude-opus-4-5-20260514',
    mountCard: (card) => {
      mounted.push(card as unknown as FakeNode);
    },
  });
  return { view, mounted };
}

function taskStart(taskId: string, extra: Record<string, unknown> = {}) {
  return {
    type: 'task-start' as const,
    agent: 'claude' as const,
    taskId,
    title: taskId,
    taskKind: 'agent' as const,
    ...extra,
  };
}

test('한 턴의 서브에이전트는 카드 하나에 모이고 시제로 완료를 알린다', () => {
  const { view, mounted } = mountFleet();
  view.beginTurn();
  view.taskStart(taskStart('t1', { title: '표 구조 조사', role: 'explore' }) as never);
  view.taskStart(taskStart('t2', { title: '문단 서식 정리' }) as never);

  assert.equal(mounted.length, 1, '에이전트 묶음은 카드 하나를 쓴다');
  const card = mounted[0];
  assert.equal(all(card, 'ag-fleet-row').length, 2);
  assert.equal(one(card, 'ag-fleet-label').textContent, '서브에이전트 2 · 작업 중');
  assert.ok(one(card, 'ag-fleet-dot').className.includes('ag-run'));

  view.taskEnd({ type: 'task-end', agent: 'claude', taskId: 't1', status: 'completed' } as never);
  // 하나가 남아 도는 동안 카드는 계속 작업 중이다.
  assert.equal(one(card, 'ag-fleet-label').textContent, '서브에이전트 2 · 작업 중');
  assert.ok(one(card, 'ag-fleet-dot').className.includes('ag-run'));

  view.taskEnd({ type: 'task-end', agent: 'claude', taskId: 't2', status: 'failed' } as never);
  assert.equal(one(card, 'ag-fleet-label').textContent, '서브에이전트 2 · 1 오류');
  assert.ok(one(card, 'ag-fleet-dot').className.includes('ag-err'));
  assert.ok(card.className.includes('ag-live') === false, '정착하면 카드가 live 를 벗는다');
  view.reset();
});

test('두 번 오는 task-end 는 빈 자리만 채우고 상태를 되돌리지 않는다', () => {
  const { view, mounted } = mountFleet();
  view.beginTurn();
  view.taskStart(taskStart('t1') as never);
  view.taskProgress({
    type: 'task-progress', agent: 'claude', taskId: 't1', usage: { totalTokens: 4200 },
  } as never);
  view.taskEnd({ type: 'task-end', agent: 'claude', taskId: 't1', status: 'completed' } as never);
  view.taskEnd({
    type: 'task-end', agent: 'claude', taskId: 't1', status: 'failed',
    summary: '표 3개를 확인했습니다', usage: { totalTokens: 5100, toolUses: 6 },
  } as never);

  const card = mounted[0];
  assert.equal(all(card, 'ag-fleet-row').length, 1, '중복 행이 생기지 않는다');
  assert.equal(one(card, 'ag-fleet-label').textContent, '서브에이전트 1 · 완료');
  assert.equal(one(card, 'ag-fleet-sr').textContent, '완료');
  assert.equal(one(card, 'ag-fleet-activity').textContent, '표 3개를 확인했습니다');
  assert.equal(one(card, 'ag-fleet-metrics').textContent, 'opus-4-5 · 5K tok · 6 도구');
  assert.equal(one(card, 'ag-fleet-sum').textContent, 'Σ 5K');
  view.reset();
});

test('워크플로는 자기 카드에 단계 레일과 멤버 행을 그린다', () => {
  const { view, mounted } = mountFleet();
  view.beginTurn();
  view.taskStart(taskStart('w1', {
    taskKind: 'workflow', title: '초안 파이프라인', workflowName: '초안 파이프라인',
  }) as never);
  view.taskStart(taskStart('a1') as never);
  assert.equal(mounted.length, 2, '워크플로는 서브에이전트 묶음과 카드를 나눠 쓴다');

  const card = mounted[0];
  view.taskProgress({
    type: 'task-progress', agent: 'claude', taskId: 'w1',
    usage: { totalTokens: 3100, toolUses: 2 },
    phases: [{ index: 0, title: '수집' }, { index: 1, title: '정리' }],
    members: [
      { index: 0, label: '수집 담당', state: 'completed', phaseIndex: 0, tokens: 1200, toolCalls: 3, model: 'claude-haiku-4-5-20260101' },
      { index: 1, label: '정리 담당', state: 'running', phaseIndex: 1, tokens: 800 },
    ],
  } as never);

  assert.equal(one(card, 'ag-fleet-label').textContent, '워크플로 · 초안 파이프라인 · 2/2 정리');
  assert.equal(all(card, 'ag-fleet-phase').length, 2);
  assert.equal(all(card, 'ag-fleet-member').length, 2);
  // 카드 Σ 는 멤버 합, 코디네이터 행은 자기 몫 — 같은 토큰을 두 번 세지 않는다.
  assert.equal(one(card, 'ag-fleet-sum').textContent, 'Σ 2K');
  const coordinator = all(card, 'ag-fleet-task')[0];
  assert.equal(one(coordinator, 'ag-fleet-metrics').textContent, 'opus-4-5 · 3K tok · 2 도구');
  assert.equal(one(coordinator, 'ag-fleet-role').hidden, true, '워크플로 이름은 카드 머리만 말한다');
  const member = all(card, 'ag-fleet-member')[0];
  assert.equal(one(member, 'ag-fleet-metrics').textContent, 'haiku-4-5 · 1K tok · 3 도구');
  assert.equal(one(member, 'ag-fleet-aside').textContent, '수집');

  // 같은 index 가 다시 와도 행을 새로 만들지 않는다.
  view.taskProgress({
    type: 'task-progress', agent: 'claude', taskId: 'w1',
    members: [{ index: 1, label: '정리 담당', state: 'failed', phaseIndex: 1, tokens: 900 }],
  } as never);
  assert.equal(all(card, 'ag-fleet-member').length, 2);
  view.taskEnd({ type: 'task-end', agent: 'claude', taskId: 'w1', status: 'completed' } as never);
  assert.equal(one(card, 'ag-fleet-label').textContent, '워크플로 · 초안 파이프라인 · 1 오류');
  view.reset();
});

test('서브에이전트가 부른 도구는 그 행의 드릴인으로 들어간다', () => {
  const { view, mounted } = mountFleet();
  view.beginTurn();
  view.taskStart(taskStart('t1') as never);
  const card = mounted[0];
  const row = one(card, 'ag-fleet-row');
  const head = one(row, 'ag-fleet-head');
  assert.equal(head.disabled, true, '기록이 없으면 열 것이 없다');

  const routed = view.routeToolCall({
    type: 'tool-call', agent: 'claude', callId: 'c1', tool: 'read_document',
    argsJson: '{"sectionIdx":0}', parentTaskId: 't1',
  } as never);
  assert.equal(routed, true);
  assert.equal(head.disabled, false);
  assert.equal(one(row, 'ag-fleet-activity').textContent, '▸ read_document');
  assert.equal(all(row, 'ag-tool-row').length, 1);
  assert.equal(one(row, 'ag-fleet-detail').hidden, true, '드릴인은 닫힌 채로 시작한다');
  head.click();
  assert.equal(one(row, 'ag-fleet-detail').hidden, false);
  assert.equal(head.getAttribute('aria-expanded'), 'true');

  assert.equal(
    view.routeToolResult({
      type: 'tool-result', agent: 'claude', callId: 'c1', ok: true, resultPreview: '문단 12개',
      parentTaskId: 't1',
    } as never),
    true,
  );
  assert.equal(one(row, 'ag-tool-result').textContent, '문단 12개');

  // 모르는 task 는 흡수하지 않고 루트 경로로 돌려준다.
  assert.equal(
    view.routeToolCall({
      type: 'tool-call', agent: 'claude', callId: 'c2', tool: 'read_document',
      argsJson: '{}', parentTaskId: 'ghost',
    } as never),
    false,
  );
  view.reset();
});

test('서브에이전트 텍스트는 행 근황으로만 남고 루트 답변에 섞이지 않는다', () => {
  const { view, mounted } = mountFleet();
  view.beginTurn();
  view.taskStart(taskStart('t1') as never);
  assert.equal(
    view.routeTextDelta({
      type: 'text-delta', agent: 'claude', text: '표를 살펴보는 중\n두 번째 줄', parentTaskId: 't1',
    } as never),
    true,
  );
  assert.equal(one(mounted[0], 'ag-fleet-activity').textContent, '두 번째 줄');
  assert.equal(
    view.routeTextDelta({ type: 'text-delta', agent: 'claude', text: 'x', parentTaskId: 'ghost' } as never),
    false,
  );
  view.reset();
});

test('턴이 끝나면 남은 행은 중단됨으로 확정된다', () => {
  const { view, mounted } = mountFleet();
  view.beginTurn();
  view.taskStart(taskStart('t1') as never);
  view.routeToolCall({
    type: 'tool-call', agent: 'claude', callId: 'c1', tool: 'read_document', argsJson: '{}',
    parentTaskId: 't1',
  } as never);
  view.sweep();

  const card = mounted[0];
  assert.equal(one(card, 'ag-fleet-sr').textContent, '중단됨');
  assert.ok(one(card, 'ag-fleet-row').className.includes('ag-stopped'));
  assert.equal(one(card, 'ag-fleet-label').textContent, '서브에이전트 1 · 중단됨');
  assert.equal(one(card, 'ag-tool-result').textContent, '(결과 없이 종료됨)');

  // 새 턴은 새 카드를 연다.
  view.beginTurn();
  view.taskStart(taskStart('t2') as never);
  assert.equal(mounted.length, 2);
  view.reset();
});

test('편대 표기 규칙 — 스폰 도구, 모델 약칭, 시계', () => {
  assert.equal(isSpawnToolName('Agent'), true);
  assert.equal(isSpawnToolName('Workflow'), true);
  assert.equal(isSpawnToolName('read_document'), false);
  assert.equal(compactModelLabel('claude-opus-4-5-20260514'), 'opus-4-5');
  assert.equal(compactModelLabel('anthropic/claude-sonnet-4-5'), 'sonnet-4-5');
  assert.equal(compactModelLabel(''), '');
  assert.equal(formatFleetClock(12_400), '12초');
  assert.equal(formatFleetClock(184_000), '3분 04초');
  assert.equal(formatFleetClock(120_000), '2분');
});

const source = readFileSync(new URL('../src/ui/agent-sidebar/index.ts', import.meta.url), 'utf8');
const css = readFileSync(new URL('../src/ui/agent-sidebar/agent-sidebar.css', import.meta.url), 'utf8');

test('사이드바가 편대 이벤트를 카드로 넘기고 스폰 도구 행은 접는다', () => {
  assert.match(source, /case 'task-start':\s*\n\s*fleetView\.taskStart\(event\);/);
  assert.match(source, /case 'task-progress':\s*\n\s*fleetView\.taskProgress\(event\);/);
  assert.match(source, /case 'task-end':\s*\n\s*fleetView\.taskEnd\(event\);/);
  assert.match(source, /if \(event\.parentTaskId && fleetView\.routeToolCall\(event\)\) break;/);
  assert.match(source, /if \(event\.parentTaskId && fleetView\.routeToolResult\(event\)\) break;/);
  assert.match(source, /if \(event\.parentTaskId && fleetView\.routeTextDelta\(event\)\) break;/);
  assert.match(source, /if \(!event\.parentTaskId && isSpawnToolName\(event\.tool\)\) \{\s*\n\s*suppressedSpawnCalls\.add\(event\.callId\);\s*\n\s*turnToolCount \+= 1;/);
  assert.match(source, /if \(suppressedSpawnCalls\.delete\(event\.callId\)\) \{/);
  assert.match(source, /fleetView\.beginTurn\(\);/);
  assert.match(source, /fleetView\.sweep\(\);/);
  assert.match(source, /fleetView\.reset\(\);/);
});

test('행 높이는 고정 그리드로 못 박혀 있고 진행 표시는 돌지 않는다', () => {
  assert.match(css, /\.ag-fleet-head\s*\{[^}]*grid-template-rows:\s*16px 14px 13px;/s);
  assert.match(css, /\.ag-fleet-head\s*\{[^}]*grid-template-columns:\s*7px minmax\(0, 1fr\) auto 11px;/s);
  assert.match(css, /\.ag-fleet-dot\.ag-run\s*\{\s*background:\s*var\(--ag-run\);/);
  assert.match(css, /\.ag-fleet-dot\.ag-ok\s*\{\s*background:\s*var\(--ag-ok\);/);
  assert.match(css, /\.ag-fleet-dot\.ag-err\s*\{\s*background:\s*var\(--ag-err\);/);
  // 편대 카드에는 도는 스피너가 없다.
  assert.doesNotMatch(css, /\.ag-fleet[^{]*\{[^}]*animation:[^;]*ag-rotate/s);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{\s*\.ag-fleet,\s*\.ag-fleet-row \{\s*animation: none;/s);
});
