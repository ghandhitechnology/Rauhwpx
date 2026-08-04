/**
 * MCP 툴 실행기 — 허브가 전달한 tool-request를 실제 문서 호출로 매핑한다.
 *
 * read 툴은 WasmBridge를 직접 호출하고(원시 doc 접근 금지), write 툴은 전부
 * PendingEditManager로 위임한다(승인 전까지 pending 상태). 모든 read 응답에
 * revision을 포함하고, 모든 write는 expectedRevision을 먼저 검사한다.
 */
import type { WasmBridge } from '../core/wasm-bridge.ts';
import type { InputHandler } from '../engine/input-handler.ts';
import type { DocumentDirtyState } from '../core/document-dirty-state.ts';
import type { DocumentPosition } from '../core/types.ts';
import type { RevisionTracker } from './revision.ts';
import type { PendingEditManager } from './pending-edits.ts';
import type { AgentName, CharFormatProps, DocRange } from './types.ts';
import { AgentToolError } from './types.ts';

export interface AgentToolExecutorDeps {
  wasm: WasmBridge;
  inputHandler: InputHandler;
  documentState: DocumentDirtyState;
  revision: RevisionTracker;
  pending: PendingEditManager;
}

const DOC_NOT_LOADED_MESSAGE = '문서가 로드되지 않았습니다';
const MAX_SVG_BYTES = 800_000;
const PENDING_NOTE = 'pending until user approves in the sidebar';

function asRecord(args: unknown): Record<string, unknown> {
  if (args !== null && typeof args === 'object' && !Array.isArray(args)) {
    return args as Record<string, unknown>;
  }
  throw new AgentToolError('INVALID_ARGS', 'Tool arguments must be an object');
}

function reqInt(args: Record<string, unknown>, key: string): number {
  const v = args[key];
  if (typeof v !== 'number' || !Number.isSafeInteger(v)) {
    throw new AgentToolError('INVALID_ARGS', `${key} must be an integer (got ${JSON.stringify(v)})`);
  }
  return v;
}

function optInt(args: Record<string, unknown>, key: string, fallback: number): number {
  const v = args[key];
  if (v === undefined || v === null) return fallback;
  if (typeof v !== 'number' || !Number.isSafeInteger(v)) {
    throw new AgentToolError('INVALID_ARGS', `${key} must be an integer (got ${JSON.stringify(v)})`);
  }
  return v;
}

function reqString(args: Record<string, unknown>, key: string): string {
  const v = args[key];
  if (typeof v !== 'string') {
    throw new AgentToolError('INVALID_ARGS', `${key} must be a string`);
  }
  return v;
}

export class AgentToolExecutor {
  private deps: AgentToolExecutorDeps;

  constructor(deps: AgentToolExecutorDeps) {
    this.deps = deps;
  }

  async execute(tool: string, args: unknown, agent: AgentName = 'claude'): Promise<unknown> {
    try {
      return this.dispatch(tool, args, agent);
    } catch (e) {
      if (e instanceof AgentToolError) throw e;
      const message = e instanceof Error ? e.message : String(e);
      if (message.includes(DOC_NOT_LOADED_MESSAGE)) {
        throw new AgentToolError('DOC_NOT_LOADED', 'No document is loaded in the studio; ask the user to open one.');
      }
      throw new AgentToolError('RPC_ERROR', message);
    }
  }

  private dispatch(tool: string, rawArgs: unknown, agent: AgentName): unknown {
    const args = rawArgs === undefined ? {} : asRecord(rawArgs);
    switch (tool) {
      case 'get_structure': return this.getStructure(args);
      case 'get_text_range': return this.getTextRange(args);
      case 'get_selection': return this.getSelection();
      case 'get_fields': return this.getFields();
      case 'get_document_info': return this.getDocumentInfo();
      case 'find_text': return this.findText(args);
      case 'render_page': return this.renderPage(args);
      case 'insert_text': return this.insertText(args, agent);
      case 'delete_range': return this.deleteRange(args, agent);
      case 'replace_range': return this.replaceRange(args, agent);
      case 'apply_char_format': return this.applyCharFormat(args, agent);
      case 'set_field_value': return this.setFieldValue(args, agent);
      default:
        throw new AgentToolError('UNKNOWN_TOOL', `Unknown tool: ${tool}`);
    }
  }

  private get revision(): number {
    return this.deps.revision.revision;
  }

  private requireDocLoaded(): void {
    if (this.deps.wasm.getSectionCount() === 0) {
      throw new AgentToolError('DOC_NOT_LOADED', 'No document is loaded in the studio; ask the user to open one.');
    }
  }

  private requireRevision(args: Record<string, unknown>): void {
    const expected = args['expectedRevision'];
    if (typeof expected !== 'number' || !Number.isSafeInteger(expected)) {
      throw new AgentToolError('INVALID_ARGS', 'expectedRevision (integer) is required for write tools');
    }
    const current = this.revision;
    if (expected !== current) {
      throw new AgentToolError(
        'REVISION_MISMATCH',
        `Document is now at revision ${current}; you expected ${expected}. ` +
          'Re-read with get_structure or get_text_range and retry with fresh coordinates.',
      );
    }
  }

  private validateAddress(sectionIdx: number, paraIdx: number, charOffset?: number): number {
    const { wasm } = this.deps;
    const sectionCount = wasm.getSectionCount();
    if (sectionIdx < 0 || sectionIdx >= sectionCount) {
      throw new AgentToolError('INVALID_ARGS', `sectionIdx ${sectionIdx} out of range (0..${sectionCount - 1})`);
    }
    const paraCount = wasm.getParagraphCount(sectionIdx);
    if (paraIdx < 0 || paraIdx >= paraCount) {
      throw new AgentToolError(
        'INVALID_ARGS',
        `paraIdx ${paraIdx} out of range for section ${sectionIdx} (0..${paraCount - 1})`,
      );
    }
    const len = wasm.getParagraphLength(sectionIdx, paraIdx);
    if (charOffset !== undefined && (charOffset < 0 || charOffset > len)) {
      throw new AgentToolError(
        'INVALID_ARGS',
        `charOffset ${charOffset} out of range for paragraph ${sectionIdx}/${paraIdx} (0..${len})`,
      );
    }
    return len;
  }

  private validateRange(args: Record<string, unknown>): DocRange {
    const range: DocRange = {
      sectionIdx: reqInt(args, 'sectionIdx'),
      startParaIdx: reqInt(args, 'startParaIdx'),
      startCharOffset: reqInt(args, 'startCharOffset'),
      endParaIdx: reqInt(args, 'endParaIdx'),
      endCharOffset: reqInt(args, 'endCharOffset'),
    };
    this.validateAddress(range.sectionIdx, range.startParaIdx, range.startCharOffset);
    this.validateAddress(range.sectionIdx, range.endParaIdx, range.endCharOffset);
    if (
      range.endParaIdx < range.startParaIdx ||
      (range.endParaIdx === range.startParaIdx && range.endCharOffset < range.startCharOffset)
    ) {
      throw new AgentToolError('INVALID_ARGS', 'Range end must not precede range start');
    }
    return range;
  }

  // ─── read tools ───────────────────────────────────────────

  private getStructure(args: Record<string, unknown>): unknown {
    this.requireDocLoaded();
    const maxPreviewChars = Math.min(Math.max(optInt(args, 'maxPreviewChars', 120), 0), 500);
    const maxParagraphs = Math.min(Math.max(optInt(args, 'maxParagraphs', 500), 1), 2000);
    const { wasm } = this.deps;
    const sectionCount = wasm.getSectionCount();
    const sections: Array<{
      sectionIdx: number;
      paragraphCount: number;
      paragraphs: Array<{ paraIdx: number; length: number; text: string }>;
    }> = [];
    let total = 0;
    let truncated = false;
    for (let sec = 0; sec < sectionCount; sec++) {
      const paragraphCount = wasm.getParagraphCount(sec);
      const paragraphs: Array<{ paraIdx: number; length: number; text: string }> = [];
      for (let para = 0; para < paragraphCount; para++) {
        if (total >= maxParagraphs) {
          truncated = true;
          break;
        }
        const length = wasm.getParagraphLength(sec, para);
        const previewLen = Math.min(length, maxPreviewChars);
        const text = previewLen > 0 ? wasm.getTextRange(sec, para, 0, previewLen) : '';
        paragraphs.push({ paraIdx: para, length, text });
        total++;
      }
      sections.push({ sectionIdx: sec, paragraphCount, paragraphs });
      if (truncated) break;
    }
    return {
      revision: this.revision,
      sectionCount,
      pageCount: wasm.pageCount,
      truncated,
      sections,
    };
  }

  private getTextRange(args: Record<string, unknown>): unknown {
    const sectionIdx = reqInt(args, 'sectionIdx');
    const paraIdx = reqInt(args, 'paraIdx');
    const charOffset = optInt(args, 'charOffset', 0);
    const paraLength = this.validateAddress(sectionIdx, paraIdx, charOffset);
    const remaining = paraLength - charOffset;
    const rawCount = optInt(args, 'count', remaining);
    if (rawCount < 0) {
      throw new AgentToolError('INVALID_ARGS', `count must be >= 0 (got ${rawCount})`);
    }
    const count = Math.min(rawCount, remaining);
    // getTextRange는 원시 문자열을 반환한다 (JSON 아님).
    const text = count > 0 ? this.deps.wasm.getTextRange(sectionIdx, paraIdx, charOffset, count) : '';
    return { revision: this.revision, text, paraLength };
  }

  private getSelection(): unknown {
    this.requireDocLoaded();
    const { inputHandler, wasm } = this.deps;
    const cursor = inputHandler.getCursorPosition();
    const sel = inputHandler.getSelection();
    const toIdx = (p: DocumentPosition) => ({
      sectionIdx: p.sectionIndex,
      paraIdx: p.paragraphIndex,
      charOffset: p.charOffset,
    });
    const inCell =
      cursor.parentParaIndex !== undefined ||
      sel?.start.parentParaIndex !== undefined ||
      sel?.end.parentParaIndex !== undefined;
    const result: Record<string, unknown> = {
      revision: this.revision,
      hasSelection: sel !== null,
      cursor: toIdx(cursor),
    };
    if (inCell) result['inCell'] = true;
    if (sel) {
      const selection: Record<string, unknown> = { start: toIdx(sel.start), end: toIdx(sel.end) };
      if (
        !inCell &&
        sel.start.sectionIndex === sel.end.sectionIndex &&
        sel.start.paragraphIndex === sel.end.paragraphIndex
      ) {
        const count = Math.min(sel.end.charOffset - sel.start.charOffset, 500);
        if (count > 0) {
          try {
            selection['text'] = wasm.getTextRange(
              sel.start.sectionIndex,
              sel.start.paragraphIndex,
              sel.start.charOffset,
              count,
            );
          } catch {
            // 선택 텍스트는 best-effort — 실패해도 좌표는 반환한다.
          }
        } else {
          selection['text'] = '';
        }
      }
      result['selection'] = selection;
    }
    return result;
  }

  private getFields(): unknown {
    const fields = this.deps.wasm.getFieldList().map((f) => ({
      fieldId: f.fieldId,
      fieldType: f.fieldType,
      name: f.name,
      guide: f.guide,
      value: f.value,
      location: { sectionIdx: f.location.sectionIndex, paraIdx: f.location.paraIndex },
    }));
    return { revision: this.revision, fields };
  }

  private getDocumentInfo(): unknown {
    this.requireDocLoaded();
    const { wasm, documentState } = this.deps;
    return {
      revision: this.revision,
      sectionCount: wasm.getSectionCount(),
      pageCount: wasm.pageCount,
      sourceFormat: wasm.getSourceFormat(),
      digest: wasm.documentDigest,
      dirty: documentState.isDirty(),
    };
  }

  private findText(args: Record<string, unknown>): unknown {
    this.requireDocLoaded();
    const query = reqString(args, 'query');
    if (query.length < 1) {
      throw new AgentToolError('INVALID_ARGS', 'query must be at least 1 character');
    }
    const caseSensitive = args['caseSensitive'] === true;
    const maxResults = Math.min(Math.max(optInt(args, 'maxResults', 50), 1), 200);
    const { wasm } = this.deps;
    const needle = caseSensitive ? query : query.toLowerCase();
    const matches: Array<{
      sectionIdx: number;
      paraIdx: number;
      charOffset: number;
      length: number;
      context: string;
    }> = [];
    let truncated = false;
    const sectionCount = wasm.getSectionCount();
    outer: for (let sec = 0; sec < sectionCount; sec++) {
      const paraCount = wasm.getParagraphCount(sec);
      for (let para = 0; para < paraCount; para++) {
        const len = wasm.getParagraphLength(sec, para);
        if (len === 0) continue;
        const text = wasm.getTextRange(sec, para, 0, len);
        const haystack = caseSensitive ? text : text.toLowerCase();
        let from = 0;
        while (from <= haystack.length - needle.length) {
          const idx = haystack.indexOf(needle, from);
          if (idx === -1) break;
          if (matches.length >= maxResults) {
            truncated = true;
            break outer;
          }
          matches.push({
            sectionIdx: sec,
            paraIdx: para,
            charOffset: idx,
            length: query.length,
            context: text.slice(Math.max(0, idx - 30), Math.min(text.length, idx + query.length + 30)),
          });
          from = idx + Math.max(needle.length, 1);
        }
      }
    }
    return { revision: this.revision, matches, truncated };
  }

  private renderPage(args: Record<string, unknown>): unknown {
    const pageIndex = reqInt(args, 'pageIndex');
    const { wasm } = this.deps;
    const pageCount = wasm.pageCount;
    if (pageCount === 0) {
      throw new AgentToolError('DOC_NOT_LOADED', 'No document is loaded in the studio; ask the user to open one.');
    }
    if (pageIndex < 0 || pageIndex >= pageCount) {
      throw new AgentToolError('INVALID_ARGS', `pageIndex ${pageIndex} out of range (0..${pageCount - 1})`);
    }
    const svg = wasm.renderPageSvg(pageIndex);
    if (svg.length > MAX_SVG_BYTES) {
      throw new AgentToolError('RESULT_TOO_LARGE', `SVG is ${svg.length} bytes; page too complex to return`);
    }
    return { revision: this.revision, pageIndex, svg };
  }

  // ─── write tools (PendingEditManager 위임) ─────────────────

  private insertText(args: Record<string, unknown>, agent: AgentName): unknown {
    this.requireRevision(args);
    const sectionIdx = reqInt(args, 'sectionIdx');
    const paraIdx = reqInt(args, 'paraIdx');
    const charOffset = reqInt(args, 'charOffset');
    const text = reqString(args, 'text');
    if (text.length < 1 || text.length > 10_000) {
      throw new AgentToolError('INVALID_ARGS', `text must be 1..10000 chars (got ${text.length})`);
    }
    this.validateAddress(sectionIdx, paraIdx, charOffset);
    const r = this.deps.pending.insertText(agent, { sectionIdx, paraIdx, charOffset }, text);
    return {
      revision: this.revision,
      changeSetId: r.changeSetId,
      insertedRange: {
        startParaIdx: r.insertedRange.startParaIdx,
        startCharOffset: r.insertedRange.startCharOffset,
        endParaIdx: r.insertedRange.endParaIdx,
        endCharOffset: r.insertedRange.endCharOffset,
      },
      note: PENDING_NOTE,
    };
  }

  private deleteRange(args: Record<string, unknown>, agent: AgentName): unknown {
    this.requireRevision(args);
    const range = this.validateRange(args);
    if (range.startParaIdx === range.endParaIdx && range.startCharOffset === range.endCharOffset) {
      throw new AgentToolError('INVALID_ARGS', 'Range is empty; nothing to delete');
    }
    const r = this.deps.pending.markDelete(agent, range);
    return {
      revision: this.revision,
      changeSetId: r.changeSetId,
      markedText: r.markedText,
      note: PENDING_NOTE,
    };
  }

  private replaceRange(args: Record<string, unknown>, agent: AgentName): unknown {
    this.requireRevision(args);
    const range = this.validateRange(args);
    if (range.startParaIdx === range.endParaIdx && range.startCharOffset === range.endCharOffset) {
      throw new AgentToolError('INVALID_ARGS', 'Range is empty; use insert_text instead');
    }
    const text = reqString(args, 'text');
    if (text.length < 1 || text.length > 10_000) {
      throw new AgentToolError('INVALID_ARGS', `text must be 1..10000 chars (got ${text.length})`);
    }
    const del = this.deps.pending.markDelete(agent, range);
    const ins = this.deps.pending.insertText(
      agent,
      { sectionIdx: range.sectionIdx, paraIdx: range.endParaIdx, charOffset: range.endCharOffset },
      text,
    );
    return {
      revision: this.revision,
      changeSetId: ins.changeSetId,
      markedText: del.markedText,
      insertedRange: {
        startParaIdx: ins.insertedRange.startParaIdx,
        startCharOffset: ins.insertedRange.startCharOffset,
        endParaIdx: ins.insertedRange.endParaIdx,
        endCharOffset: ins.insertedRange.endCharOffset,
      },
      note: PENDING_NOTE,
    };
  }

  private applyCharFormat(args: Record<string, unknown>, agent: AgentName): unknown {
    this.requireRevision(args);
    const sectionIdx = reqInt(args, 'sectionIdx');
    const paraIdx = reqInt(args, 'paraIdx');
    const startOffset = reqInt(args, 'startOffset');
    const endOffset = reqInt(args, 'endOffset');
    this.validateAddress(sectionIdx, paraIdx, startOffset);
    this.validateAddress(sectionIdx, paraIdx, endOffset);
    if (endOffset < startOffset) {
      throw new AgentToolError('INVALID_ARGS', 'endOffset must be >= startOffset');
    }
    // props_json 키 인코딩은 hwpctl/actions/format.ts charShapeSetToJson 및
    // core/types.ts CharProperties와 동일: fontSize = pt*100, textColor = '#RRGGBB'.
    const format: CharFormatProps = {};
    for (const key of ['bold', 'italic', 'underline', 'strikethrough'] as const) {
      const v = args[key];
      if (v === undefined || v === null) continue;
      if (typeof v !== 'boolean') {
        throw new AgentToolError('INVALID_ARGS', `${key} must be a boolean`);
      }
      format[key] = v;
    }
    const fontSizePt = args['fontSizePt'];
    if (fontSizePt !== undefined && fontSizePt !== null) {
      if (typeof fontSizePt !== 'number' || !Number.isFinite(fontSizePt) || fontSizePt <= 0) {
        throw new AgentToolError('INVALID_ARGS', 'fontSizePt must be a positive number');
      }
      format.fontSize = Math.round(fontSizePt * 100);
    }
    const textColor = args['textColor'];
    if (textColor !== undefined && textColor !== null) {
      if (typeof textColor !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(textColor)) {
        throw new AgentToolError('INVALID_ARGS', 'textColor must be "#RRGGBB"');
      }
      format.textColor = textColor;
    }
    if (Object.keys(format).length === 0) {
      throw new AgentToolError(
        'INVALID_ARGS',
        'At least one format key is required (bold/italic/underline/strikethrough/fontSizePt/textColor)',
      );
    }
    const range: DocRange = {
      sectionIdx,
      startParaIdx: paraIdx,
      startCharOffset: startOffset,
      endParaIdx: paraIdx,
      endCharOffset: endOffset,
    };
    const r = this.deps.pending.applyCharFormat(agent, range, format);
    return { revision: this.revision, changeSetId: r.changeSetId, applied: true, note: PENDING_NOTE };
  }

  private setFieldValue(args: Record<string, unknown>, agent: AgentName): unknown {
    this.requireRevision(args);
    const name = reqString(args, 'name');
    if (name.length < 1) {
      throw new AgentToolError('INVALID_ARGS', 'name must be at least 1 character');
    }
    const value = reqString(args, 'value');
    const r = this.deps.pending.setFieldValue(agent, name, value);
    return {
      revision: this.revision,
      changeSetId: r.changeSetId,
      fieldId: r.fieldId,
      oldValue: r.oldValue,
      newValue: r.newValue,
      note: PENDING_NOTE,
    };
  }
}
