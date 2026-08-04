import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
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
const CELL_NOTE = 'To target text INSIDE a table cell, pass the optional cell parameter (addresses come from get_structure tables[] or find_text matches); paragraph indexes and offsets are then relative to that cell.';

function cellParam() {
  return z.object({
    paraIdx: z.number().int().min(0).describe('Body paragraph index that contains the table control'),
    controlIdx: z.number().int().min(0).describe('Table control index within that paragraph'),
    cellIdx: z.number().int().min(0).describe('Flat cell index (row-major; merged cells count once)'),
  }).optional().describe('Table cell address. When present, paraIdx/startParaIdx/endParaIdx and offsets refer to paragraphs INSIDE this cell. Copy it verbatim from get_structure tables[].cells[] or a find_text match.');
}

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
  `Entry-point tool: returns the document outline — every section and paragraph with its address (sectionIdx/paraIdx), length and a text preview. Sections also carry tables[]: each table's location (paraIdx/controlIdx), dimensions, and every cell with its cellIdx, row/col and cell paragraph text — use those addresses as the cell parameter of read/write tools to work with text inside tables. Call this first to learn addresses and the current revision. ${REVISION_NOTE}`,
  {
    maxPreviewChars: z.number().int().min(0).max(500).default(120).optional()
      .describe('Max preview characters per paragraph (default 120, max 500)'),
    maxParagraphs: z.number().int().min(1).max(2000).default(500).optional()
      .describe('Max total paragraphs to include (default 500, max 2000); truncated=true when exceeded'),
  }
);

registerTool(
  'get_text_range',
  `Read the text of one paragraph (or a slice of it) at (sectionIdx, paraIdx). ${CELL_NOTE} ${REVISION_NOTE}`,
  {
    sectionIdx: z.number().int().min(0),
    paraIdx: z.number().int().min(0),
    charOffset: z.number().int().min(0).default(0).optional().describe('Start offset within the paragraph (default 0)'),
    count: z.number().int().min(0).optional().describe('Number of chars to read (default: to end of paragraph)'),
    cell: cellParam(),
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
  `Search the document body AND table cell text for a string; returns matches with exact addresses (sectionIdx, paraIdx, charOffset, length) plus surrounding context. Matches inside a table cell carry a cell object — pass it verbatim as the cell parameter of read/write tools (paraIdx of such a match is the paragraph index inside the cell). Use this to locate precise offsets before editing. ${REVISION_NOTE}`,
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
  `Insert text at (sectionIdx, paraIdx, charOffset). text may contain \\n to split paragraphs. ${CELL_NOTE} ${WRITE_NOTE} ${OFFSET_CAVEAT}`,
  {
    expectedRevision: z.number().int(),
    sectionIdx: z.number().int().min(0),
    paraIdx: z.number().int().min(0),
    charOffset: z.number().int().min(0),
    text: z.string().min(1).max(10000),
    cell: cellParam(),
  }
);

registerTool(
  'delete_range',
  `Mark a text range for deletion. The text is NOT removed yet — it is shown struck-through to the user and removed only on approval. ${CELL_NOTE} ${WRITE_NOTE} ${OFFSET_CAVEAT}`,
  {
    expectedRevision: z.number().int(),
    sectionIdx: z.number().int().min(0),
    startParaIdx: z.number().int().min(0),
    startCharOffset: z.number().int().min(0),
    endParaIdx: z.number().int().min(0),
    endCharOffset: z.number().int().min(0),
    cell: cellParam(),
  }
);

registerTool(
  'replace_range',
  `Replace a text range: marks the range for deletion (struck-through until approved) and inserts the new text right after it. ${CELL_NOTE} ${WRITE_NOTE} ${OFFSET_CAVEAT}`,
  {
    expectedRevision: z.number().int(),
    sectionIdx: z.number().int().min(0),
    startParaIdx: z.number().int().min(0),
    startCharOffset: z.number().int().min(0),
    endParaIdx: z.number().int().min(0),
    endCharOffset: z.number().int().min(0),
    text: z.string().min(1).max(10000),
    cell: cellParam(),
  }
);

registerTool(
  'apply_char_format',
  `Apply character formatting to a range within one paragraph. At least one format key is required. ${CELL_NOTE} ${WRITE_NOTE}`,
  {
    expectedRevision: z.number().int(),
    sectionIdx: z.number().int().min(0),
    paraIdx: z.number().int().min(0),
    startOffset: z.number().int().min(0),
    endOffset: z.number().int().min(0),
    cell: cellParam(),
    bold: z.boolean().optional(),
    italic: z.boolean().optional(),
    underline: z.boolean().optional(),
    strikethrough: z.boolean().optional(),
    fontSizePt: z.number().positive().optional().describe('Font size in points'),
    textColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional().describe('Text color as #RRGGBB'),
    fontFamily: z.string().min(1).max(64).optional()
      .describe('Font name, e.g. "맑은 고딕", "바탕", "Noto Sans KR" — see get_document_info fontsUsed for fonts already in the document'),
  }
);

const UNIT_NOTE = 'Lengths are in mm, font sizes in pt, colors "#RRGGBB". (Internally 1pt = 100 HWPUNIT, 1mm ≈ 283.5 HWPUNIT; A4 body with default margins is ~150mm wide.)';

registerTool(
  'create_table',
  `Create a table at (sectionIdx, paraIdx, charOffset) and optionally fill every cell in the same call — one atomic pending change. cells is a full row-major grid (rows/cols are inferred from it; short rows leave trailing cells empty; "\\n" inside a cell makes multiple paragraphs). headerRow:true marks row 0 as a repeating header (bold by default, optional headerFill shading). To merge cells afterwards call edit_table op:merge_cells, then RE-READ get_structure — merging renumbers cellIdx. Returns the table address {paraIdx, controlIdx} for follow-up calls. Example: 4 equal columns on A4: colWidthsMm [37.5, 37.5, 37.5, 37.5]. ${UNIT_NOTE} ${WRITE_NOTE}`,
  {
    expectedRevision: z.number().int(),
    sectionIdx: z.number().int().min(0),
    paraIdx: z.number().int().min(0),
    charOffset: z.number().int().min(0),
    rows: z.number().int().min(1).max(200).optional().describe('Row count; omit when cells is given (inferred)'),
    cols: z.number().int().min(1).max(64).optional().describe('Column count; omit when cells is given (inferred)'),
    cells: z.array(z.array(z.string().max(5000))).optional()
      .describe('Row-major cell texts; full grid of the table'),
    colWidthsMm: z.array(z.number().positive()).optional().describe('Column widths in mm; length must equal cols'),
    headerRow: z.boolean().optional().describe('Mark row 0 as repeating header row'),
    headerBold: z.boolean().optional().describe('Bold the header row text (default true when headerRow)'),
    headerFill: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional().describe('Header row background "#RRGGBB"'),
  }
);

registerTool(
  'edit_table',
  `Restructure an existing table at (sectionIdx, paraIdx, controlIdx) — the address comes verbatim from get_structure tables[]. op determines which extra params are required: insert_row(rowIdx, below?=true) · insert_col(colIdx, right?=true) · delete_row(rowIdx) · delete_col(colIdx) · merge_cells(startRow, startCol, endRow, endCol — row/col come from get_structure cells[].row/col, NOT cellIdx) · set_cell_props(cellIdx, props{fillColor?, verticalAlign?("top"|"center"|"bottom"), isHeader?, widthMm?, heightMm?}) · set_table_props(props{repeatHeader?}). delete_row/delete_col/merge_cells and props ops are NOT applied yet — they are highlighted and executed only when the user approves; until then further edits to the same table are rejected with PENDING_DESTRUCTIVE_OP. ${UNIT_NOTE} ${WRITE_NOTE}`,
  {
    expectedRevision: z.number().int(),
    sectionIdx: z.number().int().min(0),
    paraIdx: z.number().int().min(0).describe('Body paragraph containing the table control'),
    controlIdx: z.number().int().min(0),
    op: z.enum(['insert_row', 'insert_col', 'delete_row', 'delete_col', 'merge_cells', 'set_cell_props', 'set_table_props']),
    rowIdx: z.number().int().min(0).optional(),
    colIdx: z.number().int().min(0).optional(),
    below: z.boolean().optional().describe('insert_row: insert below rowIdx (default true)'),
    right: z.boolean().optional().describe('insert_col: insert right of colIdx (default true)'),
    startRow: z.number().int().min(0).optional(),
    startCol: z.number().int().min(0).optional(),
    endRow: z.number().int().min(0).optional(),
    endCol: z.number().int().min(0).optional(),
    cellIdx: z.number().int().min(0).optional().describe('set_cell_props: flat cell index'),
    props: z.record(z.string(), z.unknown()).optional().describe('set_cell_props / set_table_props payload'),
  }
);

registerTool(
  'apply_para_format',
  `Format one paragraph: alignment, line spacing, spacing before/after, indent, margins, page-break-before. Works in table cells via the cell parameter. pageBreakBefore:true makes the page break before this paragraph (this is also how you insert a page break). ${CELL_NOTE} ${WRITE_NOTE}`,
  {
    expectedRevision: z.number().int(),
    sectionIdx: z.number().int().min(0),
    paraIdx: z.number().int().min(0),
    cell: cellParam(),
    alignment: z.enum(['left', 'center', 'right', 'justify', 'distribute']).optional(),
    lineSpacingPercent: z.number().min(50).max(500).optional().describe('Line spacing % (100 = single, 160 = default Korean)'),
    spaceBeforePt: z.number().optional().describe('Space before paragraph in pt'),
    spaceAfterPt: z.number().optional().describe('Space after paragraph in pt'),
    indentPt: z.number().optional().describe('First-line indent in pt (negative = hanging)'),
    marginLeftPt: z.number().optional(),
    marginRightPt: z.number().optional(),
    pageBreakBefore: z.boolean().optional().describe('Start a new page before this paragraph'),
  }
);

registerTool(
  'list_styles',
  `List the document's named styles: id, name (Korean), englishName, type. Apply one with apply_style. ${REVISION_NOTE}`,
  {}
);

registerTool(
  'apply_style',
  `Apply a named document style (from list_styles) to one paragraph. Applied when the user approves. ${CELL_NOTE} ${WRITE_NOTE}`,
  {
    expectedRevision: z.number().int(),
    sectionIdx: z.number().int().min(0),
    paraIdx: z.number().int().min(0),
    cell: cellParam(),
    styleId: z.number().int().min(0),
  }
);

// ─── 이미지 삽입 — 파일은 이 프로세스(로컬)가 읽어 base64 로 전달한다 ───
const IMAGE_MAX_BYTES = 5 * 1024 * 1024;
const IMAGE_EXTS = ['png', 'jpg', 'gif', 'bmp'];

/** PNG/JPEG/GIF/BMP 헤더에서 픽셀 크기를 읽는다. 실패 시 null. */
function parseImageDims(buf, ext) {
  try {
    if (ext === 'png') {
      if (buf.length < 24 || buf.readUInt32BE(0) !== 0x89504e47) return null;
      return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
    }
    if (ext === 'gif') {
      if (buf.length < 10 || buf.toString('ascii', 0, 3) !== 'GIF') return null;
      return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
    }
    if (ext === 'bmp') {
      if (buf.length < 26 || buf.toString('ascii', 0, 2) !== 'BM') return null;
      return { width: Math.abs(buf.readInt32LE(18)), height: Math.abs(buf.readInt32LE(22)) };
    }
    if (ext === 'jpg') {
      if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null;
      let i = 2;
      while (i + 9 < buf.length) {
        if (buf[i] !== 0xff) { i++; continue; }
        const marker = buf[i + 1];
        if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
        const segLen = buf.readUInt16BE(i + 2);
        // SOF0..SOF15 (DHT/DNL/DAC 제외) 에 크기가 실린다
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
          return { width: buf.readUInt16BE(i + 7), height: buf.readUInt16BE(i + 5) };
        }
        i += 2 + segLen;
      }
      return null;
    }
  } catch {
    return null;
  }
  return null;
}

server.registerTool(
  'insert_image',
  {
    description: `Insert an image into the document at (sectionIdx, paraIdx, charOffset), inline with the text. Preferred input is imagePath — an absolute local file path; this MCP server reads the file, detects its pixel size, and streams the bytes itself (the model never emits image data). png/jpg/gif/bmp, max 5MB. Omit widthMm/heightMm to auto-fit to the page body width preserving aspect ratio; give one of them to scale proportionally. ${UNIT_NOTE} ${WRITE_NOTE}`,
    inputSchema: {
      expectedRevision: z.number().int(),
      sectionIdx: z.number().int().min(0),
      paraIdx: z.number().int().min(0),
      charOffset: z.number().int().min(0),
      imagePath: z.string().optional().describe('Absolute path to a local png/jpg/gif/bmp file (preferred)'),
      imageBase64: z.string().optional().describe('Raw base64 image data — only when the bytes are not on disk; requires extension'),
      extension: z.enum(['png', 'jpg', 'jpeg', 'gif', 'bmp']).optional().describe('Required with imageBase64; ignored with imagePath'),
      widthMm: z.number().positive().max(500).optional(),
      heightMm: z.number().positive().max(500).optional(),
      description: z.string().max(500).optional().describe('Alt text / 그림 설명'),
    },
  },
  async (args) => {
    try {
      const { imagePath, imageBase64, extension, ...rest } = args ?? {};
      let buf;
      let ext;
      if (typeof imagePath === 'string' && imagePath.length > 0) {
        buf = await readFile(imagePath);
        ext = path.extname(imagePath).slice(1).toLowerCase().replace('jpeg', 'jpg');
      } else if (typeof imageBase64 === 'string' && imageBase64.length > 0) {
        if (!extension) throw hubError('INVALID_ARGS', 'extension is required with imageBase64');
        buf = Buffer.from(imageBase64, 'base64');
        ext = extension.toLowerCase().replace('jpeg', 'jpg');
      } else {
        throw hubError('INVALID_ARGS', 'either imagePath or imageBase64 is required');
      }
      if (!IMAGE_EXTS.includes(ext)) {
        throw hubError('INVALID_ARGS', `unsupported image type "${ext}" — use png/jpg/gif/bmp`);
      }
      if (buf.length === 0) throw hubError('INVALID_ARGS', 'image file is empty');
      if (buf.length > IMAGE_MAX_BYTES) {
        throw hubError('INVALID_ARGS', `image is ${(buf.length / 1048576).toFixed(1)}MB — max 5MB`);
      }
      const dims = parseImageDims(buf, ext);
      if (!dims || dims.width < 1 || dims.height < 1) {
        throw hubError('INVALID_ARGS', 'could not read image dimensions — is the file a valid image?');
      }
      const result = await callHub('insert_image', {
        ...rest,
        imageBase64: buf.toString('base64'),
        extension: ext,
        naturalWidthPx: dims.width,
        naturalHeightPx: dims.height,
      });
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    } catch (e) {
      const code = e.code ?? (e.syscall === 'open' ? 'FILE_NOT_FOUND' : 'RPC_ERROR');
      return { content: [{ type: 'text', text: `${code}: ${e.message}` }], isError: true };
    }
  }
);

const EQUATION_SYNTAX = 'Write HWP equation script (한컴 수식) — NOT LaTeX. Core tokens: {a} over {b} (fraction) · sqrt {x} / root n of x · x^{2} y_{i} (sup/sub) · int _{0} ^{inf}, sum _{k=1} ^{n}, prod, lim _{x -> 0} · PMATRIX{ a & b # c & d } (또한 MATRIX/BMATRIX/DMATRIX; & = column, # = row) · cases{...} · greek by name: alpha beta pi omega, uppercase GAMMA SIGMA · arrows: ->, <-, <-> · decorations: bar x, vec x, hat x, dot x · rm/it font toggle · ~ thin space, # line break. Examples: "x = {-b +- sqrt {b^2 - 4ac}} over {2a}" · "int _{0} ^{inf} e^{-x^2} dx = {sqrt pi} over 2" · "sum _{k=1} ^{n} k = {n(n+1)} over 2". The script is validated by actually rendering it BEFORE insertion; syntax errors return INVALID_SCRIPT and nothing is inserted.';

registerTool(
  'insert_equation',
  `Insert an equation at (sectionIdx, paraIdx, charOffset), sized automatically and inline with text. Works inside table cells via the cell parameter. ${EQUATION_SYNTAX} ${CELL_NOTE} ${WRITE_NOTE}`,
  {
    expectedRevision: z.number().int(),
    sectionIdx: z.number().int().min(0),
    paraIdx: z.number().int().min(0),
    charOffset: z.number().int().min(0),
    cell: cellParam(),
    script: z.string().min(1).max(8000).describe('HWP equation script (한컴 수식 스크립트)'),
    fontSizePt: z.number().min(1).max(200).optional().describe('Equation font size in pt (default 10)'),
    color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional().describe('Equation color (default black)'),
  }
);

registerTool(
  'preview_equation',
  `Render an HWP equation script to SVG WITHOUT inserting it — use this to iterate on a formula until it renders correctly, then call insert_equation. ${EQUATION_SYNTAX}`,
  {
    script: z.string().min(1).max(8000),
    fontSizePt: z.number().min(1).max(200).optional(),
  }
);

registerTool(
  'insert_chart',
  `Render a chart from data and insert it as a picture at (sectionIdx, paraIdx, charOffset). Types: bar (grouped bars per series), line, pie (exactly one series), scatter (each series' values are [x0,y0,x1,y1,...] pairs). categories label the x-axis for bar/line and must match the value count. Rendered at print quality; not editable as a chart afterwards. ${UNIT_NOTE} ${WRITE_NOTE}`,
  {
    expectedRevision: z.number().int(),
    sectionIdx: z.number().int().min(0),
    paraIdx: z.number().int().min(0),
    charOffset: z.number().int().min(0),
    spec: z.object({
      type: z.enum(['bar', 'line', 'pie', 'scatter']),
      title: z.string().max(120).optional(),
      series: z.array(z.object({
        name: z.string().max(60),
        values: z.array(z.number()).min(1).max(200),
      })).min(1).max(12),
      categories: z.array(z.string().max(60)).max(100).optional(),
      xLabel: z.string().max(60).optional(),
      yLabel: z.string().max(60).optional(),
    }),
    widthMm: z.number().min(20).max(500).optional().describe('Chart width in mm (default 120)'),
    heightMm: z.number().min(20).max(500).optional().describe('Chart height in mm (default 80)'),
  }
);

registerTool(
  'set_page_layout',
  `Set the section's page geometry: paper size (named or custom mm), orientation, margins, and/or column count. Applied immediately as a pending change (whole document re-paginates); reverted if the user rejects. ${UNIT_NOTE} ${WRITE_NOTE}`,
  {
    expectedRevision: z.number().int(),
    sectionIdx: z.number().int().min(0),
    paper: z.union([
      z.enum(['A4', 'A3', 'B5', 'Letter']),
      z.object({ widthMm: z.number().min(30).max(1000), heightMm: z.number().min(30).max(1000) }),
    ]).optional(),
    landscape: z.boolean().optional().describe('true = 가로 방향 (swaps width/height as needed)'),
    marginsMm: z.object({
      left: z.number().min(0).max(100).optional(),
      right: z.number().min(0).max(100).optional(),
      top: z.number().min(0).max(100).optional(),
      bottom: z.number().min(0).max(100).optional(),
      header: z.number().min(0).max(100).optional(),
      footer: z.number().min(0).max(100).optional(),
    }).optional(),
    columns: z.object({
      count: z.number().int().min(1).max(8),
      spacingMm: z.number().min(0).max(50).optional(),
    }).optional().describe('Multi-column body layout'),
  }
);

registerTool(
  'edit_header_footer',
  `Create or replace the section's header or footer (applies to all pages). text is one line; pageNumber adds an automatic page-number field aligned left/center/right. A brand-new header/footer shows immediately as a pending change; replacing an existing one is applied only on approval. ${WRITE_NOTE}`,
  {
    expectedRevision: z.number().int(),
    sectionIdx: z.number().int().min(0),
    which: z.enum(['header', 'footer']),
    text: z.string().max(500).describe('Single-line text ("" for page number only)'),
    pageNumber: z.enum(['left', 'center', 'right']).optional().describe('Append an auto page-number field with this alignment'),
  }
);

registerTool(
  'insert_page_break',
  `Make the page break BEFORE the given paragraph (sets the paragraph's page-break-before property — paragraph indexes do not change). To break mid-paragraph, first insert_text "\\n" at the split point, then call this on the new next paragraph. ${WRITE_NOTE}`,
  {
    expectedRevision: z.number().int(),
    sectionIdx: z.number().int().min(0),
    paraIdx: z.number().int().min(0).describe('The paragraph that should start the new page'),
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
