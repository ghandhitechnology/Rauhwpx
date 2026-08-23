import assert from 'node:assert/strict';
import test from 'node:test';

import {
  sanitizeFilename,
  extractFilenameFromUrl,
  extractFilenameFromContentDisposition,
} from './filename-sanitizer.js';

test('path traversal, separators and control characters are neutralized', () => {
  assert.equal(sanitizeFilename('../../etc/passwd'), '__etc_passwd');
  assert.equal(sanitizeFilename('..\\..\\win\\file.hwp'), '__win_file.hwp');
  assert.ok(!sanitizeFilename('bad\u0000name.txt').includes('\0'));
});

test('Windows reserved device names get a safe prefix', () => {
  for (const name of ['CON', 'PRN.aux', 'NUL.hwpx', 'COM1.hml', 'LPT9.txt']) {
    const safe = sanitizeFilename(name);
    assert.match(safe, /^_/, `${name} must be prefixed → ${safe}`);
  }
  assert.equal(sanitizeFilename('console.hwp'), 'console.hwp');
});

test('Korean names survive NFC normalization within byte limits', () => {
  assert.equal(sanitizeFilename('보고서.hwp'), '보고서.hwp');
  assert.ok(Buffer.byteLength(sanitizeFilename('가'.repeat(400)), 'utf8') <= 255);
});

test('URL and Content-Disposition extraction still work', () => {
  assert.equal(extractFilenameFromUrl('https://example.com/files/공문.hwp?token=x'), '공문.hwp');
  assert.equal(
    extractFilenameFromContentDisposition('attachment; filename="plan.hwpx"'),
    'plan.hwpx',
  );
});
