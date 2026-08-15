import {
  appendMarkdown,
  type MarkdownNode,
} from './plan-markdown.ts';

type KatexModule = typeof import('katex');

let katexModule: KatexModule | null = null;
let katexLoad: Promise<void> | null = null;
const pendingMathTargets = new Set<HTMLElement>();
const markdownSourceByTarget = new WeakMap<HTMLElement, string>();

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
        if (source !== undefined && target.isConnected) renderChatMarkdown(target, source);
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

/** 기존 내용을 교체하고 채팅용 Markdown·수식을 안전한 DOM으로 렌더링한다. */
export function renderChatMarkdown(target: HTMLElement, source: string) {
  markdownSourceByTarget.set(target, source);
  target.replaceChildren();
  appendMarkdown(target, source, document, {
    links: true,
    renderMath: renderChatMath,
  });
  if (!katexModule && mayContainMath(source)) {
    pendingMathTargets.add(target);
    void loadKatex();
  }
}
