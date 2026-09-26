import {
  appendMarkdownBlocks,
  tokenizeMarkdown,
  type Block,
  type MarkdownNode,
  type MarkdownRenderOptions,
} from './plan-markdown.ts';

type KatexModule = typeof import('katex');

let katexModule: KatexModule | null = null;
let katexLoad: Promise<void> | null = null;
const pendingMathTargets = new Set<HTMLElement>();
const markdownSourceByTarget = new WeakMap<HTMLElement, { source: string; opts: ChatMarkdownOptions }>();
/** target 의 최상위 자식 순서대로, 각 노드를 만든 블록의 직렬화 키. */
const blockKeysByTarget = new WeakMap<HTMLElement, string[]>();

export interface ChatMarkdownOptions {
  /** 스트리밍 중에는 완성된 블록만 그린다. 쓰는 중인 마지막 블록은 다음 블록이 시작될 때까지 보류한다. */
  streaming?: boolean;
  /** 새로 붙은 블록에 등장 애니메이션을 준다. */
  animate?: boolean;
}

/**
 * 한국어 키보드·문서에서 백슬래시가 실제 원화 기호로 들어온 LaTeX를 복구한다.
 * 변환은 수식 경계 안에서만 수행하므로 일반 채팅의 금액 표기는 바뀌지 않는다.
 */
export function normalizeKoreanLatex(source: string) {
  return source.replace(/[₩￦]/gu, '\\');
}

function loadKatex() {
  katexLoad ??= import('katex')
    .then((module) => {
      katexModule = module;
      for (const target of pendingMathTargets) {
        const entry = markdownSourceByTarget.get(target);
        if (!entry || !target.isConnected) continue;
        // 수식 노드만 달라지므로 같은 키라도 다시 그린다.
        blockKeysByTarget.delete(target);
        renderChatMarkdown(target, entry.source, { ...entry.opts, animate: false });
      }
      pendingMathTargets.clear();
    })
    .catch(() => {
      // 네트워크·청크 로드 실패 시 원문 수식을 그대로 유지한다.
      pendingMathTargets.clear();
    });
  return katexLoad;
}

export function renderChatMath(
  node: MarkdownNode,
  source: string,
  displayMode: boolean,
) {
  if (!katexModule || typeof HTMLElement === 'undefined' || !(node instanceof HTMLElement)) return false;
  try {
    katexModule.render(normalizeKoreanLatex(source), node, {
      displayMode,
      throwOnError: true,
      strict: 'ignore',
      trust: false,
      output: 'mathml',
      maxExpand: 1_000,
      maxSize: 20,
    });
    return true;
  } catch {
    return false;
  }
}

function mayContainMath(source: string) {
  return /\$|\\[([]|[₩￦][([]/u.test(source);
}

const RE_FENCE_MARK = /^ {0,3}(```|~~~)/u;

/** 여는 펜스와 같은 종류의 줄로만 닫는다. 다른 종류의 펜스 줄은 코드 본문이다. */
function fencesClosed(source: string): boolean {
  let open: string | null = null;
  for (const line of source.split('\n')) {
    const mark = RE_FENCE_MARK.exec(line)?.[1];
    if (!mark) continue;
    if (open === null) open = mark;
    else if (open === mark) open = null;
  }
  return open === null;
}

export function stableStreamingBlocks(blocks: readonly Block[], source: string): Block[] {
  if (blocks.length === 0) return [];
  const last = blocks[blocks.length - 1]!;
  const lastClosed = fencesClosed(source) && /\n[ \t]*\n\s*$/u.test(source);
  if (lastClosed) return [...blocks];
  const stable = blocks.slice(0, -1);
  if (last.kind === 'list' && last.items.length > 1) {
    stable.push({ ...last, items: last.items.slice(0, -1) });
  }
  return stable;
}

function renderBlockNode(block: Block): HTMLElement | null {
  const fragment = document.createDocumentFragment();
  appendMarkdownBlocks(fragment, [block], document, CHAT_MARKDOWN_OPTIONS);
  const node = fragment.firstElementChild as HTMLElement | null;
  node?.setAttribute('data-md-block', '');
  return node;
}

/** 본문 블록만 고른다. 복사 버튼처럼 답변에 덧붙인 요소는 맞추기 대상이 아니다. */
function blockNodesOf(target: HTMLElement): HTMLElement[] {
  return Array.from(target.children).filter((node): node is HTMLElement =>
    node instanceof HTMLElement && node.hasAttribute('data-md-block'));
}

/** 클래스를 남기지 않는 애니메이션이라 다음 비교에서 노드가 달라 보이지 않는다. */
function markEntering(node: Element): void {
  const duration = Number.parseFloat(getComputedStyle(node).getPropertyValue('--ag-dur-slow')) || 300;
  node.animate(
    [{ opacity: 0, transform: 'translateY(3px)' }, { opacity: 1, transform: 'none' }],
    { duration, easing: 'cubic-bezier(0.22, 1, 0.36, 1)' },
  );
}

/** 같은 모양의 목록은 항목 단위로 맞춰, 이미 보이는 항목을 다시 만들지 않는다. */
function reconcileList(current: Element, next: Element, animate: boolean): void {
  const nextChildren = Array.from(next.children);
  nextChildren.forEach((child, index) => {
    const existing = current.children[index];
    if (existing?.isEqualNode(child)) return;
    if (
      existing
      && existing.tagName === child.tagName
      && existing.className === child.className
      && /^(?:UL|OL|LI)$/u.test(child.tagName)
      && existing.firstElementChild?.isEqualNode(child.firstElementChild)
    ) {
      reconcileList(existing, child, animate);
      return;
    }
    if (existing) existing.replaceWith(child);
    else current.appendChild(child);
    if (animate) markEntering(child);
  });
  while (current.children.length > nextChildren.length) current.lastElementChild?.remove();
}

const CHAT_MARKDOWN_OPTIONS: MarkdownRenderOptions = {
  links: true,
  renderMath: renderChatMath,
  fileChips: true,
};

/**
 * 채팅용 Markdown·수식을 안전한 DOM으로 렌더링한다. 블록 키가 같은 최상위 노드는
 * 그대로 두고 달라진 블록만 새로 만들어, 스트리밍 중에도 읽던 문단이 흔들리지 않는다.
 */
export function renderChatMarkdown(target: HTMLElement, source: string, opts: ChatMarkdownOptions = {}) {
  markdownSourceByTarget.set(target, { source, opts });
  const parsed = tokenizeMarkdown(source);
  const blocks = opts.streaming ? stableStreamingBlocks(parsed, source) : parsed;
  const keys = blocks.map((block) => JSON.stringify(block));
  let nodes = blockNodesOf(target);
  let previous = blockKeysByTarget.get(target);
  if (!previous || previous.length !== nodes.length) {
    for (const node of nodes) node.remove();
    nodes = [];
    previous = [];
  }
  const animate = opts.animate === true;
  keys.forEach((key, index) => {
    if (previous[index] === key) return;
    const node = renderBlockNode(blocks[index]!);
    if (!node) return;
    const existing = nodes[index];
    if (
      existing
      && /^(?:UL|OL)$/u.test(node.tagName)
      && existing.tagName === node.tagName
      && existing.getAttribute('start') === node.getAttribute('start')
    ) {
      reconcileList(existing, node, animate);
      return;
    }
    if (existing) {
      existing.replaceWith(node);
      nodes[index] = node;
    } else {
      // 새 블록은 마지막 본문 블록 바로 뒤, 덧붙인 요소보다 앞에 들어간다.
      const last = nodes[nodes.length - 1];
      target.insertBefore(node, last ? last.nextSibling : target.firstChild);
      nodes.push(node);
    }
    if (animate) markEntering(node);
  });
  while (nodes.length > keys.length) nodes.pop()?.remove();
  blockKeysByTarget.set(target, keys);
  if (!katexModule && mayContainMath(source)) {
    pendingMathTargets.add(target);
    void loadKatex();
  }
}
