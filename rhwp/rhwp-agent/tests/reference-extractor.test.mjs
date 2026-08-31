import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import JSZip from 'jszip';

import {
  MAX_DOCX_EXPANDED_BYTES,
  MAX_DOCX_ZIP_ENTRIES,
  MAX_EXTRACTED_CHARS,
  ReferenceExtractionError,
  chunkReferenceText,
  collectPdfPages,
  extractReferenceText,
  markupToText,
  preflightDocxArchive,
  runRhwpExport,
  validateDocxExpandedBytes,
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

function forgeCentralUncompressedSize(source, targetName, uncompressedSize) {
  const archive = Buffer.from(source);
  const eocdSignature = Buffer.from([0x50, 0x4b, 0x05, 0x06]);
  const eocd = archive.lastIndexOf(eocdSignature);
  assert.ok(eocd >= 0, 'fixture must contain an end-of-central-directory record');
  const entries = archive.readUInt16LE(eocd + 10);
  let cursor = archive.readUInt32LE(eocd + 16);
  for (let index = 0; index < entries; index += 1) {
    assert.equal(archive.readUInt32LE(cursor), 0x02014b50);
    const nameLength = archive.readUInt16LE(cursor + 28);
    const extraLength = archive.readUInt16LE(cursor + 30);
    const commentLength = archive.readUInt16LE(cursor + 32);
    const entryName = archive.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8');
    if (entryName === targetName) {
      archive.writeUInt32LE(uncompressedSize, cursor + 24);
      return archive;
    }
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  assert.fail(`fixture is missing ${targetName}`);
}

function forgeOverlappingMemberRange(source, firstName, secondName) {
  const archive = Buffer.from(source);
  const eocd = archive.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  assert.ok(eocd >= 0, 'fixture must contain an end-of-central-directory record');
  const entries = archive.readUInt16LE(eocd + 10);
  let cursor = archive.readUInt32LE(eocd + 16);
  const records = new Map();
  for (let index = 0; index < entries; index += 1) {
    assert.equal(archive.readUInt32LE(cursor), 0x02014b50);
    const nameLength = archive.readUInt16LE(cursor + 28);
    const extraLength = archive.readUInt16LE(cursor + 30);
    const commentLength = archive.readUInt16LE(cursor + 32);
    const entryName = archive.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8');
    records.set(entryName, { centralOffset: cursor, localOffset: archive.readUInt32LE(cursor + 42) });
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  const first = records.get(firstName);
  const second = records.get(secondName);
  assert.ok(first && second && first.localOffset < second.localOffset, 'fixture entries must be ordered');
  const firstNameLength = archive.readUInt16LE(first.localOffset + 26);
  const firstExtraLength = archive.readUInt16LE(first.localOffset + 28);
  const firstDataStart = first.localOffset + 30 + firstNameLength + firstExtraLength;
  archive.writeUInt32LE((second.localOffset - firstDataStart) + 1, first.centralOffset + 20);
  return archive;
}

test('plain UTF-8 and structured JSON are normalized for indexing', async () => {
  const plain = await extractReferenceText({ bytes: bytes('ＡＢＣ\r\n참조 문서'), name: 'notes.txt', mimeType: 'text/plain' });
  assert.equal(plain.text, 'ABC\n참조 문서');

  const json = await extractReferenceText({ bytes: bytes('{"name":"라온","active":true}'), name: 'data.json' });
  assert.equal(json.text, '{"name":"라온","active":true}');
});

test('node-dense JSON is validated without materializing an object graph', async () => {
  const dense = `[${'0,'.repeat(250_000)}0]`;
  const [first, second] = await Promise.all([
    extractReferenceText({ bytes: bytes(dense), name: 'dense-a.json' }),
    extractReferenceText({ bytes: bytes(dense), name: 'dense-b.json' }),
  ]);
  assert.equal(first.text.length, dense.length);
  assert.equal(second.text.length, dense.length);
});

test('raw text, markup, and JSON hit the character ceiling before full-string transforms', async () => {
  const oversized = 'x'.repeat(MAX_EXTRACTED_CHARS + 1);
  assert.throws(
    () => markupToText(oversized, 'large.html'),
    (error) => error.code === 'REFERENCE_TEXT_TOO_LARGE',
  );
  await assert.rejects(
    extractReferenceText({ bytes: bytes(oversized), name: 'large.txt' }),
    (error) => error.code === 'REFERENCE_TEXT_TOO_LARGE',
  );
  await assert.rejects(
    extractReferenceText({ bytes: bytes(`"${oversized}"`), name: 'large.json' }),
    (error) => error.code === 'REFERENCE_TEXT_TOO_LARGE',
  );
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

test('empty staged reference files report the empty-file code', async (t) => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rhwp-reference-empty-'));
  t.after(() => fs.rm(rootDir, { recursive: true, force: true }));
  const filePath = path.join(rootDir, 'empty.txt');
  await fs.writeFile(filePath, '');

  await assert.rejects(
    extractReferenceText({ filePath, name: 'empty.txt', mimeType: 'text/plain' }),
    (error) => error.code === 'REFERENCE_FILE_EMPTY',
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

  const unsafe = centralDirectoryZip([
    { name: '[Content_Types].xml' },
    { name: 'word/document.xml' },
    { name: '../outside.xml' },
  ]);
  assert.throws(
    () => preflightDocxArchive(unsafe, 'unsafe.docx'),
    (error) => error.code === 'REFERENCE_ARCHIVE_UNSUPPORTED' && /unsafe ZIP entry/.test(error.message),
  );

  const duplicate = centralDirectoryZip([
    { name: '[Content_Types].xml' },
    { name: 'word/document.xml' },
    { name: 'word/document.xml' },
  ]);
  assert.throws(
    () => preflightDocxArchive(duplicate, 'duplicate.docx'),
    (error) => error.code === 'REFERENCE_EXTRACTION_FAILED' && /duplicate ZIP entry/.test(error.message),
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
  assert.deepEqual(await validateDocxExpandedBytes(archive, 'normal.docx'), inspected);
});

test('DOCX validation counts actual inflation when central metadata is forged downward', async () => {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', '<Types/>');
  zip.file('word/document.xml', 'x'.repeat(4_096));
  const ordinary = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  const forged = forgeCentralUncompressedSize(ordinary, 'word/document.xml', 1);

  const claimed = preflightDocxArchive(forged, 'forged.docx', { maxExpandedBytes: 1_024 });
  assert.ok(claimed.expandedBytes < 1_024, 'forged declared sizes should pass metadata preflight');
  await assert.rejects(
    validateDocxExpandedBytes(forged, 'forged.docx', { maxExpandedBytes: 1_024 }),
    (error) => error.code === 'REFERENCE_ARCHIVE_TOO_LARGE' && /1,024 bytes/.test(error.message),
  );
});

test('DOCX validation rejects overlapping member ranges before inflation', async () => {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', '<Types/>');
  zip.file('word/document.xml', '<w:document/>');
  const ordinary = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  const forged = forgeOverlappingMemberRange(
    ordinary,
    '[Content_Types].xml',
    'word/',
  );

  await assert.rejects(
    validateDocxExpandedBytes(forged, 'overlap.docx'),
    (error) => error.code === 'REFERENCE_EXTRACTION_FAILED' && /overlapping ZIP member/.test(error.message),
  );
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

test('HWP export preserves UTF-8 characters split across stdout chunks', async () => {
  const child = Object.assign(new EventEmitter(), {
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
    stdin: new EventEmitter(),
    exitCode: null,
    signalCode: null,
    pid: 4320,
  });
  const extraction = runRhwpExport('/fake/rhwp', '/tmp/reference.hwp', 1_000, {
    spawnProcess: () => child,
  });
  const output = Buffer.from(JSON.stringify({ pages: [{ page: 0, text: '분할된 한글' }] }), 'utf8');
  const splitAt = output.indexOf(Buffer.from('한', 'utf8')) + 1;
  child.stdout.emit('data', output.subarray(0, splitAt));
  child.stdout.emit('data', output.subarray(splitAt));
  child.emit('close', 0);

  assert.deepEqual(await extraction, {
    text: '분할된 한글',
    pages: [{ page: 1, text: '분할된 한글' }],
  });
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
