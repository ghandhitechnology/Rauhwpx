export const MAX_BROWSERBASE_RESULT_TEXT_BYTES = 50 * 1024;
export const MAX_BROWSERBASE_RESULT_DEPTH = 24;
export const MAX_BROWSERBASE_RESULT_ENTRIES = 2_048;
const TRUNCATION_NOTICE = `Browserbase text output truncated at ${MAX_BROWSERBASE_RESULT_TEXT_BYTES} bytes.`;

function utf8Prefix(bytes, maxBytes) {
  let end = Math.min(bytes.length, maxBytes);
  while (end > 0) {
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, end));
    } catch {
      end -= 1;
    }
  }
  return '';
}

export function boundBrowserbaseResultContent(content) {
  const totalTextBytes = (content ?? []).reduce((total, block) => (
    block?.type === 'text'
      ? total + Buffer.byteLength(String(block.text ?? ''), 'utf8')
      : total
  ), 0);
  if (totalTextBytes <= MAX_BROWSERBASE_RESULT_TEXT_BYTES) return content ?? [];

  let remaining = MAX_BROWSERBASE_RESULT_TEXT_BYTES - Buffer.byteLength(TRUNCATION_NOTICE, 'utf8');
  const bounded = [];
  for (const block of content ?? []) {
    if (block?.type !== 'text') {
      bounded.push(block);
      continue;
    }
    const bytes = Buffer.from(String(block.text ?? ''), 'utf8');
    if (bytes.length <= remaining) {
      bounded.push(block);
      remaining -= bytes.length;
      continue;
    }
    if (remaining > 0) {
      bounded.push({ ...block, text: utf8Prefix(bytes, remaining) });
      remaining = 0;
    }
  }
  bounded.push({ type: 'text', text: TRUNCATION_NOTICE });
  return bounded;
}

function takeLiteral(text, budget) {
  const bytes = Buffer.byteLength(text, 'utf8');
  if (bytes <= budget.remainingBytes) {
    budget.remainingBytes -= bytes;
    return JSON.parse(text);
  }
  if (budget.remainingBytes >= 4) {
    budget.remainingBytes -= 4;
    return null;
  }
  return null;
}

function takeString(value, budget, reserveBytes = 0) {
  const available = Math.max(0, budget.remainingBytes - reserveBytes);
  if (available < 2) return '';
  let used = 2;
  let result = '';
  let complete = true;
  for (const character of String(value)) {
    const encoded = JSON.stringify(character);
    const cost = Buffer.byteLength(encoded, 'utf8') - 2;
    if (used + cost > available) {
      complete = false;
      break;
    }
    result += character;
    used += cost;
  }
  if (!complete) {
    const marker = '[truncated]';
    for (const character of marker) {
      const cost = Buffer.byteLength(JSON.stringify(character), 'utf8') - 2;
      if (used + cost > available) break;
      result += character;
      used += cost;
    }
    budget.truncated = true;
  }
  budget.remainingBytes -= used;
  return result;
}

/** Clone unknown Stagehand data into a bounded, cycle-free JSON value. */
export function prepareBrowserbaseJsonValue(value, {
  maxBytes = MAX_BROWSERBASE_RESULT_TEXT_BYTES,
  maxDepth = MAX_BROWSERBASE_RESULT_DEPTH,
  maxEntries = MAX_BROWSERBASE_RESULT_ENTRIES,
} = {}) {
  const wrapperBytes = Buffer.byteLength(JSON.stringify({
    data: null,
    truncated: TRUNCATION_NOTICE,
  }), 'utf8') - Buffer.byteLength('null', 'utf8');
  const budget = {
    remainingBytes: Math.max(0, maxBytes - wrapperBytes),
    remainingEntries: maxEntries,
    truncated: false,
  };
  const seen = new WeakSet();

  const visit = (input, depth) => {
    if (input === null) return takeLiteral('null', budget);
    if (typeof input === 'string') return takeString(input, budget);
    if (typeof input === 'boolean') return takeLiteral(input ? 'true' : 'false', budget);
    if (typeof input === 'number') {
      return takeLiteral(Number.isFinite(input) ? JSON.stringify(input) : 'null', budget);
    }
    if (typeof input === 'bigint') return takeString(input.toString(), budget);
    if (typeof input === 'undefined') return takeLiteral('null', budget);
    if (typeof input === 'symbol' || typeof input === 'function') {
      return takeString(`[${typeof input}]`, budget);
    }
    if (depth >= maxDepth) {
      budget.truncated = true;
      return takeString('[max depth]', budget);
    }
    if (seen.has(input)) return takeString('[circular]', budget);
    seen.add(input);
    if (input instanceof Date) return takeString(Number.isNaN(input.getTime()) ? 'Invalid Date' : input.toISOString(), budget);
    if (ArrayBuffer.isView(input) || input instanceof ArrayBuffer) {
      return takeString(`[${input.constructor?.name ?? 'binary'} ${input.byteLength ?? 0} bytes]`, budget);
    }

    if (Array.isArray(input)) {
      if (budget.remainingBytes < 2) return null;
      budget.remainingBytes -= 2;
      const output = [];
      const length = Math.min(input.length, budget.remainingEntries);
      for (let index = 0; index < length; index += 1) {
        if (budget.remainingEntries <= 0 || budget.remainingBytes < 5) {
          budget.truncated = true;
          break;
        }
        if (output.length > 0) budget.remainingBytes -= 1;
        budget.remainingEntries -= 1;
        let item;
        try { item = input[index]; } catch { item = '[unreadable]'; }
        output.push(visit(item, depth + 1));
      }
      if (length < input.length) budget.truncated = true;
      return output;
    }

    if (budget.remainingBytes < 2) return null;
    budget.remainingBytes -= 2;
    const output = Object.create(null);
    let first = true;
    for (const rawKey in input) {
      if (!Object.hasOwn(input, rawKey)) continue;
      if (budget.remainingEntries <= 0 || budget.remainingBytes < 8) {
        budget.truncated = true;
        break;
      }
      if (!first) budget.remainingBytes -= 1;
      first = false;
      budget.remainingEntries -= 1;
      const key = takeString(rawKey, budget, 5);
      budget.remainingBytes -= 1;
      let child;
      try { child = input[rawKey]; } catch { child = '[unreadable]'; }
      output[key] = visit(child, depth + 1);
    }
    return output;
  };

  const prepared = visit(value, 0);
  return budget.truncated
    ? { data: prepared, truncated: TRUNCATION_NOTICE }
    : prepared;
}

export function browserbaseJsonResult(value) {
  const prepared = prepareBrowserbaseJsonValue(value);
  return {
    content: boundBrowserbaseResultContent([{
      type: 'text',
      text: JSON.stringify(prepared),
    }]),
    isError: false,
  };
}
