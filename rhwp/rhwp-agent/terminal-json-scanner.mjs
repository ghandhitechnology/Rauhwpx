const DEFAULT_MAX_FRAME_BYTES = 8 * 1024 * 1024;

function isTerminalEvent(protocol, event) {
  if (!event || typeof event !== 'object') return false;
  if (protocol === 'claude-json') {
    return event.type === 'result'
      || event.is_error === true
      || Object.hasOwn(event, 'result')
      || Object.hasOwn(event, 'structured_output');
  }
  if (protocol === 'codex-jsonl') {
    return (event.type === 'item.completed' && event.item?.type === 'agent_message')
      || event.type === 'turn.failed';
  }
  return false;
}

/** Recognize terminal JSON without reparsing all accumulated output per chunk. */
export function createTerminalJsonScanner(protocol, {
  maxFrameBytes = DEFAULT_MAX_FRAME_BYTES,
} = {}) {
  let fragments = [];
  let frameBytes = 0;
  let started = false;
  let depth = 0;
  let inString = false;
  let escaped = false;
  let terminal = false;

  const resetFrame = () => {
    fragments = [];
    frameBytes = 0;
    started = false;
    depth = 0;
    inString = false;
    escaped = false;
  };

  const append = (value) => {
    if (!value) return true;
    frameBytes += Buffer.byteLength(value, 'utf8');
    if (frameBytes > maxFrameBytes) {
      resetFrame();
      return false;
    }
    fragments.push(value);
    return true;
  };

  return {
    push(chunk) {
      if (terminal) return true;
      const value = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
      let segmentStart = 0;

      for (let index = 0; index < value.length; index += 1) {
        const character = value[index];
        if (!started) {
          if (character !== '{') continue;
          started = true;
          depth = 1;
          segmentStart = index;
          continue;
        }

        if (inString) {
          if (escaped) escaped = false;
          else if (character === '\\') escaped = true;
          else if (character === '"') inString = false;
          continue;
        }

        if (character === '"') inString = true;
        else if (character === '{' || character === '[') depth += 1;
        else if (character === '}' || character === ']') depth -= 1;

        if (depth < 0 || character === '\n' || character === '\r') {
          resetFrame();
          segmentStart = index + 1;
          continue;
        }
        if (depth !== 0) continue;

        if (!append(value.slice(segmentStart, index + 1))) {
          segmentStart = index + 1;
          continue;
        }
        const frame = fragments.join('');
        resetFrame();
        segmentStart = index + 1;
        try {
          if (isTerminalEvent(protocol, JSON.parse(frame))) {
            terminal = true;
            return true;
          }
        } catch {}
      }

      if (started) append(value.slice(segmentStart));
      return terminal;
    },
  };
}
