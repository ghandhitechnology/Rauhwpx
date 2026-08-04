import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import WebSocket from 'ws';
import { z } from 'zod';

const WS_URL = process.env.RHWP_WS_URL ?? 'ws://127.0.0.1:5175/mcp';
const TOKEN = process.env.RHWP_AGENT_TOKEN ?? 'dev';
const AGENT_NAME = process.env.RHWP_AGENT_NAME ?? 'unknown';
const CONNECT_TIMEOUT_MS = 5_000;
const CALL_TIMEOUT_MS = 60_000;

function log(msg) {
  process.stderr.write(`[rhwp-mcp] ${msg}\n`);
}

function hubError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

/** @type {WebSocket | null} */
let ws = null;
/** @type {Promise<WebSocket> | null} */
let connecting = null;
let nextId = 1;
/** @type {Map<number, { resolve: (v: any) => void, reject: (e: any) => void, timer: NodeJS.Timeout }>} */
const inflight = new Map();

function failAllInflight(err) {
  for (const [, entry] of inflight) {
    clearTimeout(entry.timer);
    entry.reject(err);
  }
  inflight.clear();
}

function ensureConnected() {
  if (ws && ws.readyState === WebSocket.OPEN) return Promise.resolve(ws);
  if (connecting) return connecting;
  connecting = new Promise((resolve, reject) => {
    const url = `${WS_URL}?token=${encodeURIComponent(TOKEN)}&agent=${encodeURIComponent(AGENT_NAME)}`;
    let sock;
    try {
      sock = new WebSocket(url);
    } catch (e) {
      connecting = null;
      reject(hubError('HUB_UNAVAILABLE', 'rhwp-agent hub is not running (node server.mjs)'));
      return;
    }
    const openTimer = setTimeout(() => {
      try { sock.terminate(); } catch {}
      connecting = null;
      reject(hubError('HUB_UNAVAILABLE', 'rhwp-agent hub is not running (node server.mjs)'));
    }, CONNECT_TIMEOUT_MS);

    sock.on('open', () => {
      clearTimeout(openTimer);
      ws = sock;
      connecting = null;
      log(`connected to hub at ${WS_URL}`);
      resolve(sock);
    });
    sock.on('message', (data) => {
      let msg;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        log('ignoring unparseable hub frame');
        return;
      }
      if (msg?.type === 'tool-result') {
        const entry = inflight.get(msg.id);
        if (!entry) return;
        inflight.delete(msg.id);
        clearTimeout(entry.timer);
        if (msg.ok) entry.resolve(msg.result);
        else entry.reject(hubError(msg.error?.code ?? 'RPC_ERROR', msg.error?.message ?? 'unknown hub error'));
      } else if (msg?.type === 'protocol-error') {
        log(`hub protocol error: ${msg.message}`);
      }
    });
    sock.on('error', (err) => {
      clearTimeout(openTimer);
      log(`ws error: ${err?.message ?? err}`);
      if (connecting) {
        connecting = null;
        reject(hubError('HUB_UNAVAILABLE', 'rhwp-agent hub is not running (node server.mjs)'));
      }
    });
    sock.on('close', () => {
      if (ws === sock) ws = null;
      failAllInflight(hubError('HUB_UNAVAILABLE', 'connection to rhwp-agent hub was closed'));
    });
  });
  return connecting;
}

async function callHub(tool, args) {
  const sock = await ensureConnected();
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      inflight.delete(id);
      reject(hubError('STUDIO_TIMEOUT', 'Studio did not respond within 60s'));
    }, CALL_TIMEOUT_MS);
    inflight.set(id, { resolve, reject, timer });
    try {
      sock.send(JSON.stringify({ v: 1, type: 'tool-call', id, tool, args }));
    } catch (e) {
      inflight.delete(id);
      clearTimeout(timer);
      reject(hubError('HUB_UNAVAILABLE', `failed to send to hub: ${e?.message ?? e}`));
    }
  });
}

const server = new McpServer({ name: 'rhwp', version: '0.1.0' });

const REVISION_NOTE = 'Returns the current document revision. Always use the revision from your most recent tool call as expectedRevision in write tools.';
const WRITE_NOTE = 'Requires expectedRevision (the revision returned by your most recent tool call). Fails with REVISION_MISMATCH if the document changed — then re-read (get_structure / get_text_range) and retry with fresh coordinates. The edit appears to the user as a pending tinted change and only becomes final when the user approves it in the sidebar.';
const OFFSET_CAVEAT = 'charOffset counts text characters only; paragraphs containing inline controls (tables/pictures) may have offsets that do not map 1:1 to what you see — prefer find_text to locate exact offsets.';

function registerTool(name, description, shape) {
  server.registerTool(name, { description, inputSchema: shape }, async (args) => {
    try {
      const result = await callHub(name, args ?? {});
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    } catch (e) {
      return { content: [{ type: 'text', text: `${e.code ?? 'RPC_ERROR'}: ${e.message}` }], isError: true };
    }
  });
}

registerTool(
  'get_structure',
  `Entry-point tool: returns the document outline — every section and paragraph with its address (sectionIdx/paraIdx), length and a text preview. Call this first to learn addresses and the current revision. ${REVISION_NOTE}`,
  {
    maxPreviewChars: z.number().int().min(0).max(500).default(120).optional()
      .describe('Max preview characters per paragraph (default 120, max 500)'),
    maxParagraphs: z.number().int().min(1).max(2000).default(500).optional()
      .describe('Max total paragraphs to include (default 500, max 2000); truncated=true when exceeded'),
  }
);

registerTool(
  'get_text_range',
  `Read the text of one paragraph (or a slice of it) at (sectionIdx, paraIdx). ${REVISION_NOTE}`,
  {
    sectionIdx: z.number().int().min(0),
    paraIdx: z.number().int().min(0),
    charOffset: z.number().int().min(0).default(0).optional().describe('Start offset within the paragraph (default 0)'),
    count: z.number().int().min(0).optional().describe('Number of chars to read (default: to end of paragraph)'),
  }
);

registerTool(
  'get_selection',
  `Get the user's current cursor position and selection (if any) with document addresses. ${REVISION_NOTE}`,
  {}
);

registerTool(
  'get_fields',
  `List all form fields in the document: fieldId, fieldType, name, guide, value and location. ${REVISION_NOTE}`,
  {}
);

registerTool(
  'get_document_info',
  `Get document metadata: sectionCount, pageCount, sourceFormat (hwp/hwpx), content digest and dirty flag. ${REVISION_NOTE}`,
  {}
);

registerTool(
  'find_text',
  `Search the document body for a string; returns matches with exact addresses (sectionIdx, paraIdx, charOffset, length) plus surrounding context. Use this to locate precise offsets before editing. ${REVISION_NOTE}`,
  {
    query: z.string().min(1),
    caseSensitive: z.boolean().default(false).optional(),
    maxResults: z.number().int().min(1).max(200).default(50).optional(),
  }
);

registerTool(
  'render_page',
  `Render one page of the document as SVG (0-based pageIndex). Fails with RESULT_TOO_LARGE for very complex pages. ${REVISION_NOTE}`,
  {
    pageIndex: z.number().int().min(0).describe('0-based page index'),
  }
);

registerTool(
  'insert_text',
  `Insert text at (sectionIdx, paraIdx, charOffset). text may contain \\n to split paragraphs. ${WRITE_NOTE} ${OFFSET_CAVEAT}`,
  {
    expectedRevision: z.number().int(),
    sectionIdx: z.number().int().min(0),
    paraIdx: z.number().int().min(0),
    charOffset: z.number().int().min(0),
    text: z.string().min(1).max(10000),
  }
);

registerTool(
  'delete_range',
  `Mark a text range for deletion. The text is NOT removed yet — it is shown struck-through to the user and removed only on approval. ${WRITE_NOTE} ${OFFSET_CAVEAT}`,
  {
    expectedRevision: z.number().int(),
    sectionIdx: z.number().int().min(0),
    startParaIdx: z.number().int().min(0),
    startCharOffset: z.number().int().min(0),
    endParaIdx: z.number().int().min(0),
    endCharOffset: z.number().int().min(0),
  }
);

registerTool(
  'replace_range',
  `Replace a text range: marks the range for deletion (struck-through until approved) and inserts the new text right after it. ${WRITE_NOTE} ${OFFSET_CAVEAT}`,
  {
    expectedRevision: z.number().int(),
    sectionIdx: z.number().int().min(0),
    startParaIdx: z.number().int().min(0),
    startCharOffset: z.number().int().min(0),
    endParaIdx: z.number().int().min(0),
    endCharOffset: z.number().int().min(0),
    text: z.string().min(1).max(10000),
  }
);

registerTool(
  'apply_char_format',
  `Apply character formatting to a range within one paragraph. At least one format key is required. ${WRITE_NOTE}`,
  {
    expectedRevision: z.number().int(),
    sectionIdx: z.number().int().min(0),
    paraIdx: z.number().int().min(0),
    startOffset: z.number().int().min(0),
    endOffset: z.number().int().min(0),
    bold: z.boolean().optional(),
    italic: z.boolean().optional(),
    underline: z.boolean().optional(),
    strikethrough: z.boolean().optional(),
    fontSizePt: z.number().positive().optional().describe('Font size in points'),
    textColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional().describe('Text color as #RRGGBB'),
  }
);

registerTool(
  'set_field_value',
  `Set a form field's value by field name. Applied immediately (listed as a pending change in the sidebar). ${WRITE_NOTE}`,
  {
    expectedRevision: z.number().int(),
    name: z.string().min(1),
    value: z.string(),
  }
);

// 부모 CLI 가 시그널 대신 stdin 을 닫아 종료하는 경우에도 프로세스가 남지 않도록:
// 허브 WS 연결이 이벤트 루프를 붙들고 있으므로 transport 종료 시 명시적으로 나간다.
let shuttingDown = false;
function shutdown(reason) {
  if (shuttingDown) return;
  shuttingDown = true;
  log(`shutting down (${reason})`);
  failAllInflight(hubError('HUB_UNAVAILABLE', 'mcp server is shutting down'));
  try { ws?.terminate(); } catch {}
  process.exit(0);
}

const transport = new StdioServerTransport();
await server.connect(transport);
// server.connect 가 transport.onclose 를 소유하므로 Protocol 레벨 onclose 훅을 쓴다.
server.server.onclose = () => shutdown('stdio transport closed');
process.stdin.on('end', () => shutdown('stdin EOF'));
process.stdin.on('close', () => shutdown('stdin closed'));
log(`rhwp MCP stdio server started (agent=${AGENT_NAME}, hub=${WS_URL})`);

ensureConnected().then(
  () => log('eager hub connection established'),
  (e) => log(`eager hub connection failed (will retry on demand): ${e?.message ?? e}`)
);
