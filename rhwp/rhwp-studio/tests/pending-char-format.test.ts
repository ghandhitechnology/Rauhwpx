import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 접힌 캐럿에서 툴바 글꼴 변경이 커서 앞 run 에 먹히지 않고, 다음 입력에만
// 적용되도록 배선한다. 클릭 직후 hasSelection() 은 drag-anchor 때문에 true 라
// 펼친 선택과 구분해야 한다.

const studioRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const inputHandlerSrc = readFileSync(path.join(studioRoot, 'src/engine/input-handler.ts'), 'utf8');
const textSrc = readFileSync(path.join(studioRoot, 'src/engine/input-handler-text.ts'), 'utf8');
const commandSrc = readFileSync(path.join(studioRoot, 'src/engine/command.ts'), 'utf8');

function methodBody(src: string, name: string): string {
  const sig = new RegExp(`\\b${name}\\s*\\([^)]*\\)\\s*:[^\\{]*\\{`);
  const m = sig.exec(src);
  assert.ok(m, `${name} 메서드 not found`);
  const open = src.indexOf('{', m.index + m[0].length - 1);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) return src.slice(open, i + 1);
    }
  }
  throw new Error(`${name} 본문의 닫는 괄호를 찾지 못함`);
}

function classBlock(src: string, name: string): string {
  const start = src.indexOf(`export class ${name}`);
  assert.notEqual(start, -1, `${name} 클래스 not found`);
  const rel = src.slice(start + 1).indexOf('\nexport class ');
  return rel === -1 ? src.slice(start) : src.slice(start, start + 1 + rel);
}

test('format-char 는 선택이 없어도 applyCharFormat 으로 보낸다', () => {
  const start = inputHandlerSrc.indexOf("eventBus.on('format-char'");
  assert.notEqual(start, -1);
  const handler = inputHandlerSrc.slice(start, start + 500);
  assert.match(handler, /this\.applyCharFormat\(props as Partial<CharProperties>\)/);
  assert.doesNotMatch(handler, /if \(this\.cursor\.hasSelection\(\)\)/);
});

test('접힌 캐럿의 글자 서식은 pending 에 쌓고 펼친 선택에만 ApplyCharFormatCommand 를 쓴다', () => {
  const body = methodBody(inputHandlerSrc, 'applyCharFormat');
  assert.match(body, /hasNonCollapsedTextSelection\(\)/);
  assert.match(body, /mergePendingCharFormat\(props\)/);
  assert.match(body, /new ApplyCharFormatCommand/);
  const pendingIdx = body.indexOf('mergePendingCharFormat');
  const cmdIdx = body.indexOf('new ApplyCharFormatCommand');
  assert.ok(pendingIdx !== -1 && pendingIdx < cmdIdx);
});

test('hasNonCollapsedTextSelection 은 drag-anchor 접힌 선택을 펼친 범위로 치지 않는다', () => {
  const body = methodBody(inputHandlerSrc, 'hasNonCollapsedTextSelection');
  assert.match(body, /CursorState\.comparePositions\(sel\.start, sel\.end\) !== 0/);
  assert.match(body, /sel\.start\.charOffset !== sel\.end\.charOffset/);
});

test('툴바 표시와 토글 기준은 pending 서식을 덮어씌운다', () => {
  const body = methodBody(inputHandlerSrc, 'getCharPropertiesAtCursor');
  assert.match(body, /withPendingCharFormat\(/);
});

test('본문 입력과 IME 커밋은 InsertTextCommand 에 pending 서식을 실어 보낸다', () => {
  assert.match(
    textSrc,
    /new InsertTextCommand\(insertPos, text, undefined, this\.peekPendingCharFormat\?\.\(\)\)/,
  );
  assert.match(
    textSrc,
    /new InsertTextCommand\(anchor, composed, undefined, this\.peekPendingCharFormat\?\.\(\)\)/,
  );
  assert.match(textSrc, /applyPendingCharFormatToInsertedRange\?\.\(anchor, this\.compositionLength\)/);
});

test('InsertTextCommand.execute 는 insert 직후 삽입 범위에 charFormat 을 적용한다', () => {
  const block = classBlock(commandSrc, 'InsertTextCommand');
  const execute = block.slice(block.indexOf('execute(wasm'), block.indexOf('consumeTextMutationEffects'));
  assert.match(execute, /insertTextWithMutationEffects\(wasm, this\.position, this\.text\)/);
  assert.match(execute, /applyCharFormatToInsertedText\(wasm, this\.position, this\.text, this\.charFormat\)/);
  const insertIdx = execute.indexOf('insertTextWithMutationEffects');
  const formatIdx = execute.indexOf('applyCharFormatToInsertedText');
  assert.ok(insertIdx !== -1 && formatIdx > insertIdx);
});

test('InsertTextCommand 는 같은 타이핑 서식끼리만 병합한다', () => {
  const block = classBlock(commandSrc, 'InsertTextCommand');
  assert.match(
    block,
    /JSON\.stringify\(this\.charFormat \?\? null\) !== JSON\.stringify\(other\.charFormat \?\? null\)/,
  );
});

const runtimeRoot = mkdtempSync(path.join(tmpdir(), 'rhwp-pending-char-format-'));
const compiler = path.join(studioRoot, 'node_modules', 'typescript', 'bin', 'tsc');
const compilation = spawnSync(process.execPath, [
  compiler,
  '--ignoreConfig',
  'src/engine/command.ts',
  'src/engine/input-edit-invalidation.ts',
  '--target', 'ES2022',
  '--module', 'commonjs',
  '--rootDir', 'src',
  '--outDir', runtimeRoot,
  '--skipLibCheck',
  '--noCheck',
], {
  cwd: studioRoot,
  encoding: 'utf8',
});

assert.equal(
  compilation.status,
  0,
  `pending-char-format runtime compile failed:\n${compilation.stdout}${compilation.stderr}`,
);

const require = createRequire(import.meta.url);
const { InsertTextCommand } = require(path.join(runtimeRoot, 'engine', 'command.js'));

after(() => {
  rmSync(runtimeRoot, { recursive: true, force: true });
});

class FakeWasm {
  constructor() {
    this.calls = [];
  }

  replaceBodyTextLocal(...args) {
    this.calls.push({ name: 'body-local', args });
    return {
      ok: true,
      charOffset: args[2] + String(args[4]).length,
      documentPaginationPending: true,
      flowChanged: false,
    };
  }

  applyCharFormat(...args) {
    this.calls.push({ name: 'applyCharFormat', args });
    return JSON.stringify({ ok: true });
  }

  insertText(...args) {
    this.calls.push({ name: 'body-immediate', args });
    return JSON.stringify({ ok: true, charOffset: args[2] + String(args[3]).length });
  }

  deleteText(...args) {
    this.calls.push({ name: 'delete-body', args });
    return JSON.stringify({ ok: true, charOffset: args[2] });
  }
}

test('InsertTextCommand 는 삽입 범위에 타이핑 글꼴을 적용하고 redo 에도 다시 적용한다', () => {
  const wasm = new FakeWasm();
  const position = { sectionIndex: 0, paragraphIndex: 1, charOffset: 4 };
  const command = new InsertTextCommand(position, '가', 1_000, { fontId: 7 });

  command.execute(wasm);
  assert.deepEqual(wasm.calls[0], {
    name: 'body-local',
    args: [0, 1, 4, 0, '가'],
  });
  assert.deepEqual(wasm.calls[1], {
    name: 'applyCharFormat',
    args: [0, 1, 4, 5, JSON.stringify({ fontId: 7 })],
  });

  command.undo(wasm);
  wasm.calls = [];
  command.execute(wasm);
  assert.equal(wasm.calls.some((call) => call.name === 'applyCharFormat'), true);
  const apply = wasm.calls.find((call) => call.name === 'applyCharFormat');
  assert.deepEqual(apply.args, [0, 1, 4, 5, JSON.stringify({ fontId: 7 })]);
});

test('InsertTextCommand 는 charFormat 이 없으면 applyCharFormat 을 호출하지 않는다', () => {
  const wasm = new FakeWasm();
  const command = new InsertTextCommand(
    { sectionIndex: 0, paragraphIndex: 1, charOffset: 4 },
    '가',
    1_000,
  );
  command.execute(wasm);
  assert.equal(wasm.calls.some((call) => call.name === 'applyCharFormat'), false);
});
