import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import JSZip from 'jszip';

import {
  MAX_DOCX_EXPANDED_BYTES,
  MAX_DOCX_ZIP_ENTRIES,
  ReferenceExtractionError,
  chunkReferenceText,
  collectPdfPages,
  extractReferenceText,
  preflightDocxArchive,
  runRhwpExport,
} from '../reference-extractor.mjs';

function bytes(text) {
  return Buffer.from(text, 'utf8');
}

function centralDirectoryZip(entries) {
  const records = entries.map(({ name, uncompressed = 0 }) => {
    const nameBytes = Buffer.from(name, 'utf8');
    const record = Buffer.alloc(46 + nameBytes.length);
    record.writeUInt32LE(0x02014b50, 0);
    record.writeUInt16LE(20, 4);
    record.writeUInt16LE(20, 6);
    record.writeUInt32LE(uncompressed, 24);
    record.writeUInt16LE(nameBytes.length, 28);
    nameBytes.copy(record, 46);
    return record;
  });
  const central = Buffer.concat(records);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(central.length, 12);
  eocd.writeUInt32LE(0, 16);
  return Buffer.concat([central, eocd]);
}

test('plain UTF-8 and structured JSON are normalized for indexing', async () => {
  const plain = await extractReferenceText({ bytes: bytes('ＡＢＣ\r\n참조 문서'), name: 'notes.txt', mimeType: 'text/plain' });
  assert.equal(plain.text, 'ABC\n참조 문서');

  const json = await extractReferenceText({ bytes: bytes('{"name":"라온","active":true}'), name: 'data.json' });
  assert.match(json.text, /"name": "라온"/);
  assert.match(json.text, /"active": true/);
});

test('HTML/XML extraction removes active markup and decodes safe text', async () => {
  const result = await extractReferenceText({
    bytes: bytes('<html><style>.secret{}</style><script>steal()</script><body><h1>A &amp; B</h1><p>본문</p></body></html>'),
    name: 'page.html',
    mimeType: 'text/html',
  });
  assert.match(result.text, /A & B/);
  assert.match(result.text, /본문/);
  assert.doesNotMatch(result.text, /steal|secret|<h1>/);
});

test('binary, malformed JSON, and fake PDF/DOCX inputs fail explicitly', async () => {
  await assert.rejects(
    extractReferenceText({ bytes: Buffer.from([0, 1, 2]), name: 'bad.txt' }),
    (error) => error instanceof ReferenceExtractionError && error.code === 'REFERENCE_BINARY_FILE',
  );
  await assert.rejects(
    extractReferenceText({ bytes: bytes('{nope'), name: 'bad.json' }),
    (error) => error.code === 'REFERENCE_EXTRACTION_FAILED',
  );
  await assert.rejects(
    extractReferenceText({ bytes: bytes('not pdf'), name: 'fake.pdf' }),
    (error) => error.code === 'REFERENCE_TYPE_MISMATCH',
  );
  await assert.rejects(
    extractReferenceText({ bytes: bytes('not zip'), name: 'fake.docx' }),
    (error) => error.code === 'REFERENCE_TYPE_MISMATCH',
  );
});

test('PDF extraction rejects page and character floods during iteration', async () => {
  let opened = false;
  await assert.rejects(
    collectPdfPages({
      numPages: 3,
      async getPage() { opened = true; },
    }, 'many.pdf', { maxPages: 2, maxChars: 100 }),
    (error) => error.code === 'REFERENCE_PAGE_LIMIT',
  );
  assert.equal(opened, false);

  let cleaned = false;
  await assert.rejects(
    collectPdfPages({
      numPages: 1,
      async getPage() {
        return {
          async getTextContent() {
            return { items: [{ str: '1234' }, { str: '5678' }] };
          },
          cleanup() { cleaned = true; },
        };
      },
    }, 'text-flood.pdf', { maxPages: 2, maxChars: 6 }),
    (error) => error.code === 'REFERENCE_TEXT_TOO_LARGE',
  );
  assert.equal(cleaned, true);
});

test('DOCX preflight rejects ZIP entry floods and expansion bombs before Mammoth runs', () => {
  const tooMany = centralDirectoryZip([
    { name: '[Content_Types].xml' },
    { name: 'word/document.xml' },
    ...Array.from({ length: MAX_DOCX_ZIP_ENTRIES - 1 }, (_, index) => ({ name: `word/item-${index}.xml` })),
  ]);
  assert.throws(
    () => preflightDocxArchive(tooMany, 'entries.docx'),
    (error) => error.code === 'REFERENCE_ARCHIVE_TOO_LARGE' && /ZIP entries/.test(error.message),
  );

  const expanded = centralDirectoryZip([
    { name: '[Content_Types].xml', uncompressed: MAX_DOCX_EXPANDED_BYTES },
    { name: 'word/document.xml', uncompressed: 1 },
  ]);
  assert.throws(
    () => preflightDocxArchive(expanded, 'bomb.docx'),
    (error) => error.code === 'REFERENCE_ARCHIVE_TOO_LARGE' && /128 MiB/.test(error.message),
  );
});

test('DOCX preflight accepts an ordinary bounded ZIP directory', async () => {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', '<Types/>');
  zip.file('word/document.xml', '<w:document/>');
  const archive = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  const inspected = preflightDocxArchive(archive, 'normal.docx');
  assert.ok(inspected.entries >= 2 && inspected.entries <= 3);
  assert.ok(inspected.expandedBytes > 0);
});

test('chunking preserves stable ids and page locators with bounded overlap', () => {
  const pageText = `${'가나다라마바사 '.repeat(180)}끝`;
  const chunks = chunkReferenceText({
    text: pageText,
    pages: [{ page: 7, text: pageText }],
  }, { chunkChars: 500, overlapChars: 50 });
  assert.ok(chunks.length > 2);
  assert.deepEqual(chunks.map((chunk) => chunk.id), chunks.map((_, index) => `c${index}`));
  assert.ok(chunks.every((chunk) => chunk.page === 7 && chunk.text.length <= 500));
  assert.ok(chunks[1].start < chunks[0].end, 'chunks should overlap');
});

test('HWP output overflow waits for process-tree cleanup before rejecting', async () => {
  const child = Object.assign(new EventEmitter(), {
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
    stdin: new EventEmitter(),
    exitCode: null,
    signalCode: null,
    pid: 4321,
  });
  let releaseCleanup;
  const cleanup = new Promise((resolve) => { releaseCleanup = resolve; });
  const extraction = runRhwpExport('/fake/rhwp', '/tmp/reference.hwp', 1_000, {
    spawnProcess: () => child,
    terminateProcess(proc) {
      proc.signalCode = 'SIGTERM';
      proc.emit('exit', null, 'SIGTERM');
      return cleanup;
    },
  });
  let settled = false;
  void extraction.catch(() => {}).finally(() => { settled = true; });

  child.stdout.emit('data', Buffer.alloc((8 * 1024 * 1024) + 1, 0x78));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false);
  releaseCleanup(true);
  await assert.rejects(extraction, { code: 'REFERENCE_TEXT_TOO_LARGE' });
});

test('HWP cleanup uncertainty is sticky on the extraction error', async () => {
  const child = Object.assign(new EventEmitter(), {
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
    stdin: new EventEmitter(),
    exitCode: null,
    signalCode: null,
    pid: 4322,
  });
  const extraction = runRhwpExport('/fake/rhwp', '/tmp/reference.hwp', 1_000, {
    spawnProcess: () => child,
    terminateProcess(proc) {
      proc.signalCode = 'SIGTERM';
      proc.emit('exit', null, 'SIGTERM');
      return false;
    },
  });
  child.stdout.emit('data', Buffer.alloc((8 * 1024 * 1024) + 1, 0x78));
  await assert.rejects(extraction, (error) => (
    error.code === 'REFERENCE_TEXT_TOO_LARGE' && error.processCleanupUncertain === true
  ));
});
