import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

/* DOM 없이 편대 카드를 검증하는 최소 노드. 실제 Element 와 같은 형태만 흉내낸다. */
class FakeNode {
  tagName: string;
  className = '';
  attrs: Record<string, string> = {};
  children: FakeNode[] = [];
  parentNode: FakeNode | null = null;
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
    child.parentNode?.removeChild(child);
    child.parentNode = this;
    this.children.push(child);
    return child;
  }

  append(...nodes: FakeNode[]): void {
    for (const node of nodes) this.appendChild(node);
  }

  removeChild(child: FakeNode): FakeNode {
    const index = this.children.indexOf(child);
    if (index >= 0) this.children.splice(index, 1);
    child.parentNode = null;
    return child;
  }

  replaceChildren(...nodes: FakeNode[]): void {
    for (const child of this.children) child.parentNode = null;
    this.own = '';
    this.children = [];
    this.append(...nodes);
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
  const settled: FakeNode[] = [];
  const conversation = new FakeNode('div');
  const view = createSubagentFleet({
    doc: fakeDoc as unknown as Document,
    sessionModel: () => 'claude-opus-4-5-20260514',
    settleCard: (card) => {
      const node = card as unknown as FakeNode;
      conversation.appendChild(node);
      settled.push(node);
    },
  });
  return { view, settled };
}

/** 도크 팝업에 머물러 있는 카드들 — 살아 있는 편대다. */
function hostedCards(view: { root: FakeNode }): FakeNode[] {
  return all(view.root, 'ag-fleet');
}

function pill(view: { root: FakeNode }): FakeNode {
  return one(view.root, 'ag-fleet-dock-pill');
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

test('한 턴의 서브에이전트는 도크 팝업에 모이고 정착하면 흐름으로 떠난다', () => {
  const { view, settled } = mountFleet();
  view.beginTurn();
  view.taskStart(taskStart('t1', { title: '표 구조 조사', role: 'explore' }) as never);
  view.taskStart(taskStart('t2', { title: '문단 서식 정리' }) as never);

  // 살아 있는 동안 카드는 입력기 위 팝업에 머무른다.
  assert.equal(settled.length, 0, '도는 동안 카드는 흐름으로 가지 않는다');
  const hosted = hostedCards(view);
  assert.equal(hosted.length, 1, '에이전트 묶음은 카드 하나를 쓴다');
  const card = hosted[0];
  assert.equal(all(card, 'ag-fleet-row').length, 2);
  assert.equal(one(card, 'ag-fleet-label').textContent, '서브에이전트 2 · 작업 중');
  assert.ok(one(card, 'ag-fleet-dot').className.includes('ag-run'));
  // 알약은 남은 작업 수를 말하고 픽셀 휠을 싣는다.
  assert.equal(one(view.root, 'ag-fleet-dock-label').textContent, '서브에이전트 2 · 작업 중');
  assert.equal(all(pill(view), 'ag-pixel-bit').length, 8);
  assert.equal((view.root as unknown as FakeNode).hidden, false);

  view.taskEnd({ type: 'task-end', agent: 'claude', taskId: 't1', status: 'completed' } as never);
  // 하나가 남아 도는 동안 카드는 계속 작업 중이다.
  assert.equal(settled.length, 0);
  assert.equal(one(card, 'ag-fleet-label').textContent, '서브에이전트 2 · 작업 중');

  view.taskEnd({ type: 'task-end', agent: 'claude', taskId: 't2', status: 'failed' } as never);
  assert.equal(one(card, 'ag-fleet-label').textContent, '서브에이전트 2 · 1 오류');
  assert.ok(one(card, 'ag-fleet-dot').className.includes('ag-err'));
  assert.ok(card.className.includes('ag-live') === false, '정착하면 카드가 live 를 벗는다');
  // 정착한 카드는 흐름으로 옮겨지고 도크는 비어 숨는다.
  assert.equal(settled.length, 1, '정착한 카드는 호출부로 넘긴다');
  assert.equal(hostedCards(view).length, 0, '팝업에서 사라진다');
  assert.equal((view.root as unknown as FakeNode).hidden, true, '할 일이 없으면 도크도 숨는다');
  view.reset();
});

test('두 번 오는 task-end 는 빈 자리만 채우고 상태를 되돌리지 않는다', () => {
  const { view, settled } = mountFleet();
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

  // 첫 task-end 에 카드가 정착하지만 참조는 유효하다 — 늦게 온 요약도 같은 행에 채운다.
  assert.equal(settled.length, 1);
  const card = settled[0];
  assert.equal(all(card, 'ag-fleet-row').length, 1, '중복 행이 생기지 않는다');
  assert.equal(one(card, 'ag-fleet-label').textContent, '서브에이전트 1 · 완료');
  assert.equal(one(card, 'ag-fleet-sr').textContent, '완료');
  assert.equal(one(card, 'ag-fleet-activity').textContent, '표 3개를 확인했습니다');
  assert.equal(one(card, 'ag-fleet-metrics').textContent, 'opus-4-5 · 5K tok · 6 도구');
  assert.equal(one(card, 'ag-fleet-sum').textContent, 'Σ 5K');
  view.reset();
});

test('정착한 카드 뒤에 같은 턴의 새 서브에이전트가 오면 새 카드에 모은다', () => {
  const { view, settled } = mountFleet();
  view.beginTurn();
  view.taskStart(taskStart('t1') as never);
  view.taskEnd({ type: 'task-end', agent: 'claude', taskId: 't1', status: 'completed' } as never);
  assert.equal(settled.length, 1);
  view.taskStart(taskStart('t2') as never);
  assert.equal(hostedCards(view).length, 1, '정착한 카드에 섞이지 않는다');
  assert.equal(one(view.root, 'ag-fleet-dock-label').textContent, '서브에이전트 1 · 작업 중');
  view.reset();
});

test('워크플로는 자기 카드에 단계 레일과 멤버 행을 그린다', () => {
  const { view, settled } = mountFleet();
  view.beginTurn();
  view.taskStart(taskStart('w1', {
    taskKind: 'workflow', title: '초안 파이프라인', workflowName: '초안 파이프라인',
  }) as never);
  view.taskStart(taskStart('a1') as never);
  assert.equal(hostedCards(view).length, 2, '워크플로는 서브에이전트 묶음과 카드를 나눠 쓴다');

  const card = hostedCards(view)[0];
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
  const { view } = mountFleet();
  view.beginTurn();
  view.taskStart(taskStart('t1') as never);
  const card = hostedCards(view)[0];
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
  const { view } = mountFleet();
  view.beginTurn();
  view.taskStart(taskStart('t1') as never);
  assert.equal(
    view.routeTextDelta({
      type: 'text-delta', agent: 'claude', text: '표를 살펴보는 중\n두 번째 줄', parentTaskId: 't1',
    } as never),
    true,
  );
  assert.equal(one(hostedCards(view)[0], 'ag-fleet-activity').textContent, '두 번째 줄');
  assert.equal(
    view.routeTextDelta({ type: 'text-delta', agent: 'claude', text: 'x', parentTaskId: 'ghost' } as never),
    false,
  );
  view.reset();
});

test('턴이 끝나면 남은 행은 중단됨으로 확정되고 카드는 흐름으로 떠난다', () => {
  const { view, settled } = mountFleet();
  view.beginTurn();
  view.taskStart(taskStart('t1') as never);
  view.routeToolCall({
    type: 'tool-call', agent: 'claude', callId: 'c1', tool: 'read_document', argsJson: '{}',
    parentTaskId: 't1',
  } as never);
  view.sweep();

  const card = settled[0];
  assert.equal(one(card, 'ag-fleet-sr').textContent, '중단됨');
  assert.ok(one(card, 'ag-fleet-row').className.includes('ag-stopped'));
  assert.equal(one(card, 'ag-fleet-label').textContent, '서브에이전트 1 · 중단됨');
  assert.equal(one(card, 'ag-tool-result').textContent, '(결과 없이 종료됨)');
  assert.equal(hostedCards(view).length, 0, '정착한 카드는 팝업을 떠난다');

  // 새 턴은 새 카드를 연다.
  view.beginTurn();
  view.taskStart(taskStart('t2') as never);
  assert.equal(settled.length, 1);
  assert.equal(hostedCards(view).length, 1);
  view.reset();
});

test('알약 클릭은 팝업을 접었다 펼치고 aria-expanded 를 따라간다', () => {
  const { view } = mountFleet();
  view.beginTurn();
  view.taskStart(taskStart('t1') as never);
  const pill = one(view.root, 'ag-fleet-dock-pill');
  const popup = one(view.root, 'ag-fleet-popup');
  // 새 묶음이 태어나면 팝업은 열린 채로 시작한다.
  assert.equal(popup.hidden, false);
  assert.equal(pill.getAttribute('aria-expanded'), 'true');

  pill.click();
  assert.equal(popup.hidden, true);
  assert.equal(pill.getAttribute('aria-expanded'), 'false');
  pill.click();
  assert.equal(popup.hidden, false);

  // 새 카드가 태어나면 다시 연다 — 사용자가 접어 둔 상태와 상관없이.
  pill.click();
  view.beginTurn();
  view.taskStart(taskStart('t2') as never);
  assert.equal(popup.hidden, false);
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

test('행 높이는 고정 그리드로 못 박혀 있고 진행 표시는 픽셀 휠 하나다', () => {
  assert.match(css, /\.ag-fleet-head\s*\{[^}]*grid-template-rows:\s*16px 14px 13px;/s);
  assert.match(css, /\.ag-fleet-head\s*\{[^}]*grid-template-columns:\s*12px minmax\(0, 1fr\) auto 11px;/s);
  assert.match(css, /\.ag-fleet-dot\.ag-run\s*\{\s*background:\s*var\(--ag-run\);/);
  assert.match(css, /\.ag-fleet-dot\.ag-ok\s*\{\s*background:\s*var\(--ag-ok\);/);
  assert.match(css, /\.ag-fleet-dot\.ag-err\s*\{\s*background:\s*var\(--ag-err\);/);
  // 진행 표시는 step 타이밍으로 칸을 건너뛰는 픽셀 휠이다 — 부드러운 회전이 아니다.
  assert.match(css, /\.ag-pixel-bit\s*\{[^}]*animation:\s*ag-pixel-chase [^;]*steps\(1/s);
  assert.match(css, /\.ag-fleet-row\.ag-live \.ag-fleet-spin \{\s*\n\s*display: block;/);
  assert.match(css, /\.ag-fleet\.ag-codex \{ --ag-accent: var\(--ag-codex\); \}/);
  assert.doesNotMatch(css, /ag-fleet-card-spin/);
  // 도는 동안에는 점이 아니라 휠이 그 자리를 쓴다.
  assert.match(css, /\.ag-fleet-row\.ag-live \.ag-fleet-dot \{\s*\n\s*display: none;/s);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{\s*\.ag-fleet,\s*\.ag-fleet-row \{\s*animation: none;/s);
});

test('편대 도크는 입력기 위 알약과 팝업으로 그려진다', () => {
  assert.match(css, /\.ag-fleet-dock\s*\{[^}]*position:\s*absolute;/s);
  assert.match(css, /\.ag-fleet-dock-pill\s*\{[^}]*border-radius:\s*999px;/s);
  assert.match(css, /\.ag-fleet-popup\s*\{[^}]*max-height:\s*min\(320px, 40vh\);/s);
  // 도크가 서 있는 동안 계획 복원 overlay 는 도크 위로 올라간다.
  assert.match(source, /--ag-fleet-dock-h/);
  assert.match(css, /var\(--ag-fleet-dock-h, 0px\)/);
});
