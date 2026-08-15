import test from 'node:test';
import assert from 'node:assert/strict';

import {
  appendMarkdown,
  escapeMarkdown,
  planToMarkdown,
  safeMarkdownHref,
  tokenizeInline,
  tokenizeMarkdown,
  type MarkdownRenderOptions,
} from '../src/ui/agent-sidebar/plan-markdown.ts';
import { normalizeKoreanLatex } from '../src/ui/agent-sidebar/chat-markdown.ts';
import type { StructuredPlan } from '../src/agent/types.ts';

/* DOM 없이 렌더러를 검증하는 최소 노드. 실제 Document 와 같은 형태만 흉내낸다. */
class FakeNode {
  tag: string;
  className = '';
  attrs: Record<string, string> = {};
  children: FakeNode[] = [];
  private text = '';

  constructor(tag: string) {
    this.tag = tag;
  }

  get textContent(): string {
    if (this.children.length === 0) return this.text;
    return this.children.map((child) => child.textContent).join('');
  }

  set textContent(value: string) {
    this.children = [];
    this.text = value;
  }

  appendChild(child: FakeNode): FakeNode {
    this.children.push(child);
    return child;
  }

  setAttribute(name: string, value: string): void {
    this.attrs[name] = value;
  }

  /** `tag.class` 형태의 얕은 트리 표기 — 구조 단언용. */
  outline(): string {
    const label = this.className ? `${this.tag}.${this.className.split(' ')[0]}` : this.tag;
    if (this.children.length === 0) return label;
    return `${label}(${this.children.map((child) => child.outline()).join(',')})`;
  }

  find(className: string): FakeNode[] {
    const hit = this.className.split(' ').includes(className) ? [this as FakeNode] : [];
    return this.children.reduce<FakeNode[]>((acc, child) => acc.concat(child.find(className)), hit);
  }
}

const host = {
  createElement: (tag: string) => new FakeNode(tag),
  createTextNode: (text: string) => {
    const node = new FakeNode('#text');
    node.textContent = text;
    return node;
  },
  createDocumentFragment: () => new FakeNode('#fragment'),
};

function render(src: string, options: MarkdownRenderOptions = {}): FakeNode {
  const root = new FakeNode('div');
  appendMarkdown(root as never, src, host as never, options);
  return root;
}

function plan(overrides: Partial<StructuredPlan> = {}): StructuredPlan {
  return {
    planId: 'plan-1',
    title: '표 정리',
    goal: '표 서식을 통일한다',
    summary: '문서 전체 표의 머리글 서식을 맞춥니다.',
    assumptions: [],
    decisions: [],
    steps: [],
    files: [],
    validation: [],
    risks: [],
    exclusions: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    epoch: 1,
    ...overrides,
  };
}

test('블록 토크나이저가 제목·목록·인용·코드·구분선을 구분한다', () => {
  const blocks = tokenizeMarkdown(
    '## 단계\n1. 첫 항목\n   보조 설명\n2. 둘째\n\n> 인용\n\n```ts\nconst a = 1;\n```\n\n---\n문단',
  );
  assert.deepEqual(blocks.map((block) => block.kind), [
    'heading', 'list', 'quote', 'code', 'hr', 'paragraph',
  ]);
  const list = blocks[1] as Extract<(typeof blocks)[number], { kind: 'list' }>;
  assert.equal(list.ordered, true);
  assert.equal(list.items.length, 2);
  assert.deepEqual(list.items[0]?.notes, ['보조 설명']);
  const code = blocks[3] as Extract<(typeof blocks)[number], { kind: 'code' }>;
  assert.equal(code.lang, 'ts');
  assert.equal(code.code, 'const a = 1;');
});

test('체크박스 항목은 상태를 가진 목록 항목이 된다', () => {
  const blocks = tokenizeMarkdown('- [x] 끝난 일\n- [ ] 남은 일\n- 보통 항목');
  const list = blocks[0] as Extract<(typeof blocks)[number], { kind: 'list' }>;
  assert.deepEqual(list.items.map((item) => item.task), ['done', 'todo', 'none']);
  assert.equal(list.items[0]?.text, '끝난 일');
});

test('인라인 토크나이저가 코드·강조를 나누고 링크는 표시 문자열만 남긴다', () => {
  assert.deepEqual(tokenizeInline('a `b` **c** *d*'), [
    { kind: 'text', text: 'a ' },
    { kind: 'code', text: 'b' },
    { kind: 'text', text: ' ' },
    { kind: 'strong', text: 'c' },
    { kind: 'text', text: ' ' },
    { kind: 'em', text: 'd' },
  ]);
  assert.deepEqual(tokenizeInline('[문서](https://example.com)를 보세요'), [
    { kind: 'link', text: '문서', href: 'https://example.com' },
    { kind: 'text', text: '를 보세요' },
  ]);
});

test('한국어 조사·식별자와 맞닿은 강조 문법을 과하게 해석하지 않는다', () => {
  assert.deepEqual(tokenizeInline('**중요**합니다. *강조*는 유지하고 변수_이름_값은 그대로 둡니다.'), [
    { kind: 'strong', text: '중요' },
    { kind: 'text', text: '합니다. ' },
    { kind: 'em', text: '강조' },
    { kind: 'text', text: '는 유지하고 변수_이름_값은 그대로 둡니다.' },
  ]);
});

test('한국어 키보드의 원화 기호는 수식 안에서만 LaTeX 백슬래시로 복구한다', () => {
  assert.equal(normalizeKoreanLatex('₩frac{1}{2} + ￦alpha'), '\\frac{1}{2} + \\alpha');
  assert.equal(render('가격은 ₩10,000이고 ₩frac는 일반 텍스트입니다.').textContent,
    '가격은 ₩10,000이고 ₩frac는 일반 텍스트입니다.');
});

test('인라인·블록 수식과 한국어 원화 기호 구분자를 토큰화한다', () => {
  assert.deepEqual(tokenizeInline('공식 $E=mc^2$는 같고 ₩(x+1₩)도 같습니다.'), [
    { kind: 'text', text: '공식 ' },
    { kind: 'math', source: 'E=mc^2', raw: '$E=mc^2$' },
    { kind: 'text', text: '는 같고 ' },
    { kind: 'math', source: 'x+1', raw: '₩(x+1₩)' },
    { kind: 'text', text: '도 같습니다.' },
  ]);
  const blocks = tokenizeMarkdown('$$\n\\frac{가}{나}\n$$');
  assert.deepEqual(blocks, [{
    kind: 'math',
    source: '\\frac{가}{나}',
    raw: '$$\n\\frac{가}{나}\n$$',
  }]);
});

test('닫히지 않은 수식과 이스케이프된 달러는 원문으로 남는다', () => {
  assert.deepEqual(tokenizeMarkdown('$$\n아직 작성 중'), [
    { kind: 'paragraph', text: '$$ 아직 작성 중' },
  ]);
  assert.equal(render('가격은 \\$5입니다.').textContent, '가격은 $5입니다.');
  assert.equal(render(String.raw`경로 C:\Users\andy와 \frac는 그대로`).textContent,
    String.raw`경로 C:\Users\andy와 \frac는 그대로`);
});

test('한국어 NFC·NFD와 입력 한계의 마지막 Unicode 문자를 훼손하지 않는다', () => {
  const korean = '한글 한글 e\u0301';
  assert.equal(render(korean).textContent, korean);
  const clipped = tokenizeMarkdown(`${'a'.repeat(119_999)}😀뒤`)[0];
  assert.ok(clipped?.kind === 'paragraph');
  assert.equal(clipped.text.endsWith('\uD83D'), false);
  assert.equal(clipped.text.includes('�'), false);
});

test('표와 명시적 줄바꿈을 네이티브 문서 구조로 렌더링한다', () => {
  const root = render('항목 | 값\n--- | ---:\n한글 | **좋음**\n\n첫 줄  \n둘째 줄');
  assert.equal(root.find('ag-md-table').length, 1);
  assert.equal(root.find('ag-md-align-right').length, 2);
  assert.equal(root.find('ag-md-break').length, 1);
  assert.equal(root.textContent, '항목값한글좋음첫 줄둘째 줄');
});

test('채팅 링크는 안전한 외부 프로토콜만 활성화한다', () => {
  assert.equal(safeMarkdownHref('https://한글.example/문서'), 'https://한글.example/문서');
  assert.equal(safeMarkdownHref('mailto:test@example.com'), 'mailto:test@example.com');
  assert.equal(safeMarkdownHref('javascript:alert(1)'), null);
  assert.equal(safeMarkdownHref('/local/path'), null);
  const root = render('[문서](https://example.com)', { links: true });
  assert.equal(root.find('ag-md-link')[0]?.attrs.rel, 'noopener noreferrer');
});

test('수식 렌더러 실패 시 원문을 보존하고 성공 시 결과를 사용한다', () => {
  const failed = render('$x$', { renderMath: () => false });
  assert.equal(failed.textContent, '$x$');
  const rendered = render('$x$', {
    renderMath: (node) => {
      node.textContent = '수식';
      return true;
    },
  });
  assert.equal(rendered.textContent, '수식');
});

test('렌더러는 HTML 과 위험한 링크를 실행 가능한 요소로 만들지 않는다', () => {
  const root = render(
    '<img src=x onerror=alert(1)> [클릭](javascript:alert(1))\n\n<script>bad()</script>',
    { links: true },
  );
  const tags = new Set<string>();
  const walk = (node: FakeNode): void => {
    tags.add(node.tag);
    node.children.forEach(walk);
  };
  walk(root);
  assert.ok(!tags.has('a'));
  assert.ok(!tags.has('img'));
  assert.ok(!tags.has('script'));
  assert.match(root.textContent, /<img src=x onerror=alert\(1\)>/);
  assert.match(root.textContent, /<script>bad\(\)<\/script>/);
  assert.equal(root.textContent.includes('javascript:'), false);
});

test('렌더 결과는 문서 구조에 맞는 요소를 만든다', () => {
  const root = render('## 검증\n- [ ] `cargo test` 실행\n\n> 주의\n\n```\nraw\n```');
  assert.equal(
    root.outline(),
    'div(h4.ag-md-h(#text),ul.ag-md-list(li.ag-md-li(span.ag-md-checkbox,'
      + 'span.ag-md-li-text(code.ag-md-code,#text))),blockquote.ag-md-quote(p.ag-md-p(#text)),'
      + 'pre.ag-md-pre(code.ag-md-block-code))',
  );
  assert.equal(root.find('ag-md-task')[0]?.className.includes('ag-md-task-todo'), true);
  assert.equal(root.find('ag-md-block-code')[0]?.textContent, 'raw');
});

test('계획 직렬화는 제목·목표를 빼고 채워진 절만 낸다', () => {
  const md = planToMarkdown(plan({
    steps: [{ title: '머리글 굵게', details: '1행만 바꿉니다', files: ['a.hwpx'] }],
    files: ['a.hwpx'],
    validation: ['미리보기 확인'],
  }));
  assert.ok(!md.includes('표 정리'));
  assert.ok(!md.includes('표 서식을 통일한다'));
  assert.match(md, /^## 개요\n문서 전체 표의 머리글 서식을 맞춥니다\./);
  assert.match(md, /## 단계\n1\. \*\*머리글 굵게\*\*\n {3}1행만 바꿉니다\n {3}파일 `a\.hwpx`/);
  assert.match(md, /## 예상 파일\n- `a\.hwpx`/);
  assert.match(md, /## 검증\n- \[ \] 미리보기 확인/);
  assert.ok(!md.includes('## 위험'));
  assert.ok(!md.includes('## 가정'));
});

test('계획 본문의 마크다운 기호는 문법으로 되살아나지 않는다', () => {
  assert.equal(escapeMarkdown('# 제목 **강조**'), '\\# 제목 \\*\\*강조\\*\\*');
  const md = planToMarkdown(plan({ summary: '## 가짜 제목 <b>굵게</b>' }));
  const blocks = tokenizeMarkdown(md);
  assert.equal(blocks[0]?.kind, 'heading');
  assert.equal(blocks[1]?.kind, 'paragraph');
  assert.equal(render(md).textContent, '개요## 가짜 제목 <b>굵게</b>');
});

test('비정상적으로 큰 입력에서도 블록 수가 제한된다', () => {
  const blocks = tokenizeMarkdown('문단\n\n'.repeat(5_000));
  assert.ok(blocks.length <= 1_200);
});
