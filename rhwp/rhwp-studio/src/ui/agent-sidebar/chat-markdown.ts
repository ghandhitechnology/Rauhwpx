import {
  appendMarkdown,
  type MarkdownNode,
} from './plan-markdown.ts';

type KatexModule = typeof import('katex');

let katexModule: KatexModule | null = null;
let katexLoad: Promise<void> | null = null;
const pendingMathTargets = new Set<HTMLElement>();
const markdownSourceByTarget = new WeakMap<HTMLElement, string>();
const incrementalTargets = new WeakSet<HTMLElement>();

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
        const source = markdownSourceByTarget.get(target);
        if (source !== undefined && target.isConnected) renderChatMarkdown(target, source, incrementalTargets.has(target));
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

/** 스트리밍 중 변하지 않은 노드는 유지한다. */
function reconcileMarkdown(target: Node, next: Node): void {
  const incoming = Array.from(next.childNodes);
  for (let index = 0; index < incoming.length; index++) {
    const fresh = incoming[index];
    const current = target.childNodes[index];
    if (!current) target.appendChild(fresh);
    else if (current.nodeType !== fresh.nodeType || current.nodeName !== fresh.nodeName) target.replaceChild(fresh, current);
    else if (current.nodeType === Node.TEXT_NODE) {
      if (current.nodeValue !== fresh.nodeValue) current.nodeValue = fresh.nodeValue;
    } else if (current instanceof Element && fresh instanceof Element) {
      for (const attribute of Array.from(current.attributes)) {
        if (!fresh.hasAttribute(attribute.name)) current.removeAttribute(attribute.name);
      }
      for (const attribute of Array.from(fresh.attributes)) {
        if (current.getAttribute(attribute.name) !== attribute.value) current.setAttribute(attribute.name, attribute.value);
      }
      reconcileMarkdown(current, fresh);
    }
  }
  while (target.childNodes.length > incoming.length) target.removeChild(target.lastChild!);
}

export function renderChatMarkdown(target: HTMLElement, source: string, preserveNodes = false) {
  markdownSourceByTarget.set(target, source);
  if (preserveNodes) incrementalTargets.add(target);
  else incrementalTargets.delete(target);
  const output = preserveNodes ? document.createElement('div') : target;
  if (!preserveNodes) target.replaceChildren();
  appendMarkdown(output, source, document, {
    links: true,
    renderMath: renderChatMath,
  });
  if (preserveNodes) reconcileMarkdown(target, output);
  if (!katexModule && mayContainMath(source)) {
    pendingMathTargets.add(target);
    void loadKatex();
  }
}
