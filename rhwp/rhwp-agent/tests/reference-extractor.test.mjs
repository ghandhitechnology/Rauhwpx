import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ReferenceExtractionError,
  chunkReferenceText,
  extractReferenceText,
} from '../reference-extractor.mjs';

function bytes(text) {
  return Buffer.from(text, 'utf8');
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
