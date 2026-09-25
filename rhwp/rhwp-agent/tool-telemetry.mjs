// 도구 호출 텔레메트리 — 턴마다 JSONL 한 줄.
//
// 모델/추론 시간은 재지 않는다. 허브가 보는 도구 호출만 센다: 이름, 인자 바이트,
// 결과 글자 수(모델이 읽게 되는 텍스트), 이미지 수와 픽셀, 도구 ms, 에러 코드.
// 문서 내용이나 인자 값은 기록하지 않는다 (도구 이름 외 PII 없음).
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { z } from 'zod/v3';
import { zodToJsonSchema } from 'zod-to-json-schema';

import { imageDetails } from './insert-image-source.mjs';

export const TOOL_TELEMETRY_FILE = 'tool-telemetry.jsonl';
/** 이 크기를 넘으면 .1 로 한 번 굴리고 새로 쓴다. */
export const MAX_TOOL_TELEMETRY_BYTES = 8 * 1024 * 1024;
/** 한 턴 행에 싣는 호출 상세의 상한 — 합계는 상한과 무관하게 전부 센다. */
export const MAX_TURN_CALL_DETAILS = 256;

/**
 * 도구 정의 한 건이 모델에게 보이는 글자 수 — 설명 + MCP SDK 와 같은 옵션으로 만든 입력 스키마.
 * tools.test 의 크기 한도와 agent-tool-bench 의 정의 크기 보고가 같은 잣대를 쓴다.
 */
export function toolDefinitionChars(definition) {
  const schema = zodToJsonSchema(z.object(definition.shape), { strictUnions: true, pipeStrategy: 'input' });
  return definition.description.length + JSON.stringify(schema).length;
}

/** 정의 목록의 합계와 큰 순서 상위 항목. */
export function measureToolDefinitions(definitions, { top = 5 } = {}) {
  const sizes = definitions.map((definition) => ({ name: definition.name, chars: toolDefinitionChars(definition) }));
  sizes.sort((a, b) => b.chars - a.chars);
  return {
    tools: sizes.length,
    totalChars: sizes.reduce((sum, entry) => sum + entry.chars, 0),
    largest: sizes.slice(0, top),
  };
}

/** base64 이미지의 픽셀 수. 모르는 형식이면 0. */
export function imagePixels(base64) {
  if (typeof base64 !== 'string' || base64.length === 0) return 0;
  try {
    // PNG/GIF/BMP 는 앞 몇십 바이트로 충분하다 — JPEG 만 전체를 푼다.
    const size = imageDetails(Buffer.from(base64.slice(0, 64), 'base64'))
      ?? imageDetails(Buffer.from(base64, 'base64'));
    return size ? size.width * size.height : 0;
  } catch {
    return 0;
  }
}

/**
 * 도구 결과가 모델에게 얼마나 무거운지 잰다.
 * 텍스트 글자 수는 toToolContent 가 만드는 text 블록과 같은 기준(JSON 문자열)이다.
 */
export function measureToolResult(result) {
  const measured = { resultChars: 0, images: 0, imagePixels: 0 };
  if (result && typeof result === 'object' && Array.isArray(result.mcpContent)) {
    for (const block of result.mcpContent) {
      if (block?.type === 'image') {
        measured.images += 1;
        measured.imagePixels += imagePixels(block.data);
      } else if (typeof block?.text === 'string') {
        measured.resultChars += block.text.length;
      } else {
        measured.resultChars += JSON.stringify(block ?? null).length;
      }
    }
    return measured;
  }
  const image = result && typeof result === 'object' ? result.image : null;
  if (image && typeof image === 'object' && typeof image.data === 'string') {
    const { image: _omit, ...rest } = result;
    measured.images = 1;
    measured.imagePixels = imagePixels(image.data);
    measured.resultChars = JSON.stringify(rest).length;
    return measured;
  }
  measured.resultChars = (JSON.stringify(result ?? null) ?? '').length;
  return measured;
}

function argsBytes(args) {
  try {
    return Buffer.byteLength(JSON.stringify(args ?? {}) ?? '');
  } catch {
    return 0;
  }
}

/**
 * 호출 하나의 측정을 시작한다. 어느 턴에 넣을지는 끝날 때 정한다:
 * finish(turn, { result }) 또는 finish(turn, { errorCode, errorMessage }). turn 이 없으면 버린다.
 */
export function startToolCall(tool, args) {
  const t0 = performance.now();
  const bytes = argsBytes(args);
  let settled = false;
  return {
    finish(turn, { result, errorCode = null, errorMessage = '' } = {}) {
      if (settled || !turn) return;
      settled = true;
      const ms = Math.round((performance.now() - t0) * 10) / 10;
      const measured = errorCode
        ? { resultChars: String(errorCode).length + String(errorMessage ?? '').length, images: 0, imagePixels: 0 }
        : measureToolResult(result);
      turn.record({ tool, argsBytes: bytes, ms, errorCode, ...measured });
    },
  };
}

/** 한 턴의 도구 호출 누산기. */
export class ToolTurnTelemetry {
  constructor(turnId = null) {
    this.turnId = turnId;
    this.startedAt = Date.now();
    this.toolCalls = 0;
    this.argsBytes = 0;
    this.resultChars = 0;
    this.images = 0;
    this.imagePixels = 0;
    this.toolMs = 0;
    this.errors = {};
    this.retries = {};
    this.calls = [];
    this.lastErrorByTool = new Map();
  }

  /** 호출 시작 — 반환된 함수로 끝을 알린다. */
  begin(tool, args) {
    const call = startToolCall(tool, args);
    return (outcome) => call.finish(this, outcome);
  }

  record({ tool, argsBytes: bytes = 0, resultChars = 0, images = 0, imagePixels: pixels = 0, ms = 0, errorCode = null }) {
    this.toolCalls += 1;
    this.argsBytes += bytes;
    this.resultChars += resultChars;
    this.images += images;
    this.imagePixels += pixels;
    this.toolMs = Math.round((this.toolMs + ms) * 10) / 10;
    // 재시도 = 같은 도구가 직전에 실패한 뒤 다시 불린 호출. 직전 실패 코드로 센다.
    const previousError = this.lastErrorByTool.get(tool);
    if (previousError) this.retries[previousError] = (this.retries[previousError] ?? 0) + 1;
    if (errorCode) {
      this.errors[errorCode] = (this.errors[errorCode] ?? 0) + 1;
      this.lastErrorByTool.set(tool, errorCode);
    } else {
      this.lastErrorByTool.delete(tool);
    }
    if (this.calls.length < MAX_TURN_CALL_DETAILS) {
      this.calls.push({ tool, argsBytes: bytes, resultChars, images, imagePixels: pixels, ms, ...(errorCode ? { error: errorCode } : {}) });
    }
  }

  summary() {
    return {
      toolCalls: this.toolCalls,
      argsBytes: this.argsBytes,
      resultChars: this.resultChars,
      images: this.images,
      imagePixels: this.imagePixels,
      toolMs: this.toolMs,
      errors: { ...this.errors },
      retries: { ...this.retries },
      calls: this.calls.map((call) => ({ ...call })),
    };
  }
}

/** 턴 행을 JSONL 로 덧붙인다. 실패는 삼킨다 — 텔레메트리가 턴을 막으면 안 된다. */
export async function appendToolTelemetryRow(dir, row, { maxBytes = MAX_TOOL_TELEMETRY_BYTES } = {}) {
  const file = path.join(dir, TOOL_TELEMETRY_FILE);
  try {
    const stat = await fs.stat(file).catch(() => null);
    if (stat && stat.size > maxBytes) await fs.rename(file, `${file}.1`);
    await fs.appendFile(file, `${JSON.stringify(row)}\n`, { mode: 0o600 });
    return true;
  } catch {
    return false;
  }
}

/** 기록된 턴 행을 읽는다 (테스트/벤치용 게터). */
export async function readToolTelemetryRows(dir) {
  const text = await fs.readFile(path.join(dir, TOOL_TELEMETRY_FILE), 'utf8').catch(() => '');
  return text.split('\n').filter(Boolean).flatMap((line) => {
    try { return [JSON.parse(line)]; } catch { return []; }
  });
}
