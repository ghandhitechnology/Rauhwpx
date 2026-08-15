/**
 * 계획 문서용 Markdown 직렬화 + 안전 렌더러.
 *
 * 의존성이 없고 innerHTML 을 쓰지 않는다. 모든 텍스트는 createTextNode /
 * textContent 로만 들어가므로 원문에 섞인 HTML 은 그대로 글자로 남는다.
 * 링크는 표시 문자열만 남기고 클릭 대상은 만들지 않는다.
 */

import type { StructuredPlan, StructuredPlanStep } from '../../agent/types.ts';

/* ── DOM 최소 계약 ─────────────────────────────────────────
   실제 Document·HTMLElement 가 구조적으로 이 형태를 만족한다.
   테스트는 같은 모양의 가짜 노드를 넘겨 DOM 없이 검증한다. */
export interface MarkdownNode {
  textContent: string | null;
  appendChild(child: never): unknown;
  setAttribute?(name: string, value: string): void;
  className?: string;
}

export interface MarkdownHost {
  createElement(tag: string): MarkdownNode;
  createTextNode(text: string): MarkdownNode;
  createDocumentFragment(): MarkdownNode;
}

/* ── 한계값 ────────────────────────────────────────────────
   비정상적으로 큰 입력에서도 렌더 시간이 선형에 머물도록 자른다. */
export const MD_LIMITS = {
  maxChars: 120_000,
  maxLines: 4_000,
  maxBlocks: 1_200,
  maxListItems: 400,
  maxInlineSpans: 600,
  maxQuoteDepth: 2,
} as const;

/* ── 토큰 ──────────────────────────────────────────────── */
export type InlineToken =
  | { kind: 'text'; text: string }
  | { kind: 'code'; text: string }
  | { kind: 'strong'; text: string }
  | { kind: 'em'; text: string };

export interface ListItem {
  /** 항목 첫 줄. */
  text: string;
  /** 이어지는 들여쓴 줄들 (설명, 파일 목록 등). */
  notes: string[];
  depth: number;
  task: 'none' | 'todo' | 'done';
}

export type Block =
  | { kind: 'heading'; level: number; text: string }
  | { kind: 'paragraph'; text: string }
  | { kind: 'list'; ordered: boolean; start: number; items: ListItem[] }
  | { kind: 'quote'; blocks: Block[] }
  | { kind: 'code'; lang: string; code: string }
  | { kind: 'hr' };

const RE_HR = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const RE_HEADING = /^ {0,3}(#{1,6})[ \t]+(.*)$/;
const RE_FENCE = /^ {0,3}(```|~~~)[ \t]*([A-Za-z0-9_+-]{0,20})[ \t]*$/;
const RE_ITEM = /^(\s*)(?:([-*+])|(\d{1,9})[.)])[ \t]+(.*)$/;

function normalize(src: string): string[] {
  const clipped = src.length > MD_LIMITS.maxChars ? src.slice(0, MD_LIMITS.maxChars) : src;
  const lines = clipped.replace(/\r\n?/g, '\n').replace(/\t/g, '  ').split('\n');
  return lines.length > MD_LIMITS.maxLines ? lines.slice(0, MD_LIMITS.maxLines) : lines;
}

/** Markdown 부분집합을 블록 목록으로 바꾼다. 순수 함수. */
export function tokenizeMarkdown(src: string, quoteDepth = 0): Block[] {
  const lines = normalize(src);
  const blocks: Block[] = [];
  let paragraph: string[] = [];

  const flushParagraph = (): void => {
    if (paragraph.length === 0) return;
    if (blocks.length < MD_LIMITS.maxBlocks) {
      blocks.push({ kind: 'paragraph', text: paragraph.join(' ').trim() });
    }
    paragraph = [];
  };

  let i = 0;
  while (i < lines.length && blocks.length < MD_LIMITS.maxBlocks) {
    const line = lines[i] ?? '';

    const fence = RE_FENCE.exec(line);
    if (fence) {
      flushParagraph();
      const marker = fence[1] ?? '```';
      const body: string[] = [];
      i += 1;
      while (i < lines.length) {
        const current = lines[i] ?? '';
        if (current.trimStart().startsWith(marker)) {
          i += 1;
          break;
        }
        body.push(current);
        i += 1;
      }
      blocks.push({ kind: 'code', lang: fence[2] ?? '', code: body.join('\n') });
      continue;
    }

    if (line.trim() === '') {
      flushParagraph();
      i += 1;
      continue;
    }

    if (RE_HR.test(line)) {
      flushParagraph();
      blocks.push({ kind: 'hr' });
      i += 1;
      continue;
    }

    const heading = RE_HEADING.exec(line);
    if (heading) {
      flushParagraph();
      const text = (heading[2] ?? '').replace(/[ \t]+#+[ \t]*$/, '').trim();
      blocks.push({ kind: 'heading', level: (heading[1] ?? '#').length, text });
      i += 1;
      continue;
    }

    if (/^ {0,3}>/.test(line)) {
      flushParagraph();
      const body: string[] = [];
      while (i < lines.length && /^ {0,3}>/.test(lines[i] ?? '')) {
        body.push((lines[i] ?? '').replace(/^ {0,3}>[ \t]?/, ''));
        i += 1;
      }
      const inner = quoteDepth >= MD_LIMITS.maxQuoteDepth
        ? [{ kind: 'paragraph' as const, text: body.join(' ').trim() }]
        : tokenizeMarkdown(body.join('\n'), quoteDepth + 1);
      blocks.push({ kind: 'quote', blocks: inner });
      continue;
    }

    const first = RE_ITEM.exec(line);
    if (first) {
      flushParagraph();
      const ordered = first[3] !== undefined;
      const start = ordered ? Math.max(1, Number(first[3])) : 1;
      const items: ListItem[] = [];
      while (i < lines.length && items.length < MD_LIMITS.maxListItems) {
        const match = RE_ITEM.exec(lines[i] ?? '');
        if (!match) break;
        if ((match[3] !== undefined) !== ordered) break;
        const indent = (match[1] ?? '').length;
        items.push({ ...readItem(match[4] ?? ''), depth: Math.min(2, Math.floor(indent / 2)), notes: [] });
        const item = items[items.length - 1]!;
        i += 1;
        // 이어지는 들여쓴 줄은 같은 항목의 보조 설명으로 붙인다.
        while (i < lines.length) {
          const next = lines[i] ?? '';
          if (next.trim() === '' || RE_ITEM.test(next)) break;
          if (next.search(/\S/) <= indent) break;
          if (item.notes.length < 8) item.notes.push(next.trim());
          i += 1;
        }
        if ((lines[i] ?? '').trim() === '' && RE_ITEM.test(lines[i + 1] ?? '')) i += 1;
      }
      blocks.push({ kind: 'list', ordered, start, items });
      continue;
    }

    paragraph.push(line.trim());
    i += 1;
  }
  flushParagraph();
  return blocks;
}

function readItem(raw: string): { text: string; task: ListItem['task'] } {
  const task = /^\[([ xX])\][ \t]+/.exec(raw);
  if (!task) return { text: raw.trim(), task: 'none' };
  return {
    text: raw.slice(task[0].length).trim(),
    task: (task[1] ?? ' ').toLowerCase() === 'x' ? 'done' : 'todo',
  };
}

/** 인라인 마크업(코드·강조·링크 표시문자)을 토큰으로 나눈다. 순수 함수. */
export function tokenizeInline(src: string): InlineToken[] {
  const tokens: InlineToken[] = [];
  let buffer = '';
  const push = (token: InlineToken): void => {
    if (buffer) {
      tokens.push({ kind: 'text', text: buffer });
      buffer = '';
    }
    tokens.push(token);
  };
  let i = 0;
  while (i < src.length) {
    if (tokens.length >= MD_LIMITS.maxInlineSpans) {
      buffer += src.slice(i);
      break;
    }
    const ch = src[i]!;
    if (ch === '\\' && i + 1 < src.length) {
      buffer += src[i + 1];
      i += 2;
      continue;
    }
    if (ch === '`') {
      const end = src.indexOf('`', i + 1);
      if (end > i + 1) {
        push({ kind: 'code', text: src.slice(i + 1, end) });
        i = end + 1;
        continue;
      }
    }
    if ((ch === '*' || ch === '_') && src[i + 1] === ch) {
      const end = src.indexOf(ch + ch, i + 2);
      if (end > i + 2) {
        push({ kind: 'strong', text: src.slice(i + 2, end) });
        i = end + 2;
        continue;
      }
    }
    if (ch === '*' || ch === '_') {
      const end = src.indexOf(ch, i + 1);
      if (end > i + 1 && !/\s/.test(src[i + 1] ?? ' ')) {
        push({ kind: 'em', text: src.slice(i + 1, end) });
        i = end + 1;
        continue;
      }
    }
    if (ch === '[') {
      // 링크는 표시 문자열만 남긴다 — 클릭 대상은 만들지 않는다.
      const link = /^!?\[([^\]\n]{0,300})\]\(([^)\s]{0,500})(?:[ \t][^)\n]{0,200})?\)/.exec(src.slice(i));
      if (link) {
        buffer += link[1] ?? '';
        i += link[0].length;
        continue;
      }
    }
    buffer += ch;
    i += 1;
  }
  if (buffer) tokens.push({ kind: 'text', text: buffer });
  return tokens;
}

function resolveHost(host?: MarkdownHost): MarkdownHost {
  if (host) return host;
  const doc = (globalThis as { document?: MarkdownHost }).document;
  if (!doc) throw new Error('Markdown 렌더러에 document 가 필요합니다.');
  return doc;
}

function add(parent: MarkdownNode, child: MarkdownNode): MarkdownNode {
  (parent.appendChild as (node: MarkdownNode) => unknown)(child);
  return child;
}

function element(host: MarkdownHost, tag: string, className?: string): MarkdownNode {
  const node = host.createElement(tag);
  if (className) node.className = className;
  return node;
}

function appendInline(host: MarkdownHost, parent: MarkdownNode, text: string): void {
  for (const token of tokenizeInline(text)) {
    if (token.kind === 'text') {
      add(parent, host.createTextNode(token.text));
      continue;
    }
    const tag = token.kind === 'code' ? 'code' : token.kind === 'strong' ? 'strong' : 'em';
    const node = element(host, tag, `ag-md-${token.kind}`);
    node.textContent = token.text;
    add(parent, node);
  }
}

function appendBlocks(host: MarkdownHost, parent: MarkdownNode, blocks: readonly Block[]): void {
  for (const block of blocks) {
    switch (block.kind) {
      case 'heading': {
        const level = Math.min(6, Math.max(1, block.level));
        const node = element(host, `h${level + 2 > 6 ? 6 : level + 2}`, `ag-md-h ag-md-h${level}`);
        appendInline(host, node, block.text);
        add(parent, node);
        break;
      }
      case 'paragraph': {
        const node = element(host, 'p', 'ag-md-p');
        appendInline(host, node, block.text);
        add(parent, node);
        break;
      }
      case 'hr':
        add(parent, element(host, 'hr', 'ag-md-hr'));
        break;
      case 'code': {
        const pre = element(host, 'pre', 'ag-md-pre');
        const code = element(host, 'code', 'ag-md-block-code');
        if (block.lang) code.setAttribute?.('data-lang', block.lang);
        code.textContent = block.code;
        add(pre, code);
        add(parent, pre);
        break;
      }
      case 'quote': {
        const node = element(host, 'blockquote', 'ag-md-quote');
        appendBlocks(host, node, block.blocks);
        add(parent, node);
        break;
      }
      case 'list':
        appendList(host, parent, block);
        break;
    }
  }
}

function appendList(
  host: MarkdownHost,
  parent: MarkdownNode,
  block: Extract<Block, { kind: 'list' }>,
): void {
  const root = element(host, block.ordered ? 'ol' : 'ul', 'ag-md-list');
  if (block.ordered && block.start !== 1) root.setAttribute?.('start', String(block.start));
  add(parent, root);
  // depth 0/1/2 만 지원한다 — 더 깊은 들여쓰기는 마지막 단계로 접힌다.
  const stack: MarkdownNode[] = [root];
  let lastItem: MarkdownNode | null = null;
  for (const item of block.items) {
    const depth = Math.min(item.depth, stack.length - 1 + 1);
    while (stack.length - 1 > depth) stack.pop();
    if (depth > stack.length - 1 && lastItem) {
      const nested = element(host, block.ordered ? 'ol' : 'ul', 'ag-md-list ag-md-list-nested');
      add(lastItem, nested);
      stack.push(nested);
    }
    const parentList = stack[stack.length - 1]!;
    const li = element(host, 'li', item.task === 'none' ? 'ag-md-li' : `ag-md-li ag-md-task ag-md-task-${item.task}`);
    if (item.task !== 'none') {
      const mark = element(host, 'span', 'ag-md-checkbox');
      mark.setAttribute?.('aria-hidden', 'true');
      add(li, mark);
    }
    const line = element(host, 'span', 'ag-md-li-text');
    appendInline(host, line, item.text);
    add(li, line);
    for (const note of item.notes) {
      const noteNode = element(host, 'span', 'ag-md-li-note');
      appendInline(host, noteNode, note);
      add(li, noteNode);
    }
    add(parentList, li);
    lastItem = li;
  }
}

/** Markdown 을 안전한 DOM 노드로 그려 target 에 붙인다. */
export function appendMarkdown(target: MarkdownNode, src: string, host?: MarkdownHost): void {
  const resolved = resolveHost(host);
  appendBlocks(resolved, target, tokenizeMarkdown(src));
}

/** 렌더 결과를 fragment 로 돌려준다. */
export function renderMarkdown(src: string, host?: MarkdownHost): MarkdownNode {
  const resolved = resolveHost(host);
  const fragment = resolved.createDocumentFragment();
  appendBlocks(resolved, fragment, tokenizeMarkdown(src));
  return fragment;
}

/* ── 계획을 Markdown 으로 ─────────────────────────────── */

/** 계획 본문 글자를 Markdown 문법으로 재해석되지 않게 막는다. */
export function escapeMarkdown(text: string): string {
  return text
    .replace(/[\\`*_[\]<>#|~]/g, (ch) => `\\${ch}`)
    .replace(/^([ \t]*)(\d{1,9})([.)])/gm, '$1$2\\$3')
    .replace(/^([ \t]*)([-+])(\s)/gm, '$1\\$2$3');
}

function clean(text: string): string {
  return escapeMarkdown(text.trim()).replace(/\n+/g, ' ');
}

function listSection(
  title: string,
  items: readonly string[] | undefined,
  options: { code?: boolean; tasks?: boolean } = {},
): string[] {
  const rows = (items ?? []).map((item) => item.trim()).filter(Boolean);
  if (rows.length === 0) return [];
  const prefix = options.tasks ? '- [ ] ' : '- ';
  const body = rows.map((item) => (
    options.code
      ? `${prefix}\`${item.replace(/`/g, '')}\``
      : `${prefix}${clean(item)}`
  ));
  return [`## ${clean(title)}`, ...body, ''];
}

function stepLines(step: StructuredPlanStep, index: number): string[] {
  const lines = [`${index + 1}. **${clean(step.title || '단계')}**`];
  const details = (step.details ?? '').trim();
  if (details) lines.push(`   ${clean(details)}`);
  const files = (step.files ?? []).map((file) => file.trim()).filter(Boolean);
  if (files.length > 0) lines.push(`   파일 ${files.map((file) => `\`${file.replace(/`/g, '')}\``).join(', ')}`);
  return lines;
}

/**
 * 구조화된 계획을 문서용 Markdown 으로 바꾼다.
 * 제목·목표는 뷰어 머리말이 맡으므로 본문에는 넣지 않는다.
 */
export function planToMarkdown(plan: StructuredPlan): string {
  const out: string[] = [];
  const summary = (plan.summary || '').trim();
  if (summary) out.push('## 개요', clean(summary), '');

  const steps = plan.steps ?? [];
  if (steps.length > 0) {
    out.push('## 단계');
    steps.forEach((step, index) => out.push(...stepLines(step, index)));
    out.push('');
  }

  out.push(...listSection('예상 파일', plan.files, { code: true }));
  out.push(...listSection('검증', plan.validation, { tasks: true }));
  out.push(...listSection('위험', plan.risks));
  out.push(...listSection('가정', plan.assumptions));
  out.push(...listSection('결정', plan.decisions));
  out.push(...listSection('제외', plan.exclusions));

  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}
