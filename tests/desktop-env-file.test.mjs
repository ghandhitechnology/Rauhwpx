import assert from 'node:assert/strict';
import test from 'node:test';
import { loadEnvFileInto, parseEnvFile, selectEnvFile, __test } from '../desktop/env-file.mjs';

test('parseEnvFile skips blanks, comments, and malformed lines', () => {
  const entries = parseEnvFile([
    '# leading comment',
    '',
    '   # indented comment',
    'BARE_KEY=value',
    'export EXPORTED_KEY=exported-value',
    'NO_EQUALS_SIGN',
    '=missing-key',
    'SPACED KEY = invalid-key-with-space',
    'TRIMMED_KEY = trimmed-value',
  ].join('\n'));
  assert.deepEqual(entries, [
    ['BARE_KEY', 'value'],
    ['EXPORTED_KEY', 'exported-value'],
    ['TRIMMED_KEY', 'trimmed-value'],
  ]);
});

test('parseEnvFile unquotes single and double quoted values', () => {
  const entries = parseEnvFile([
    "SINGLE='quoted value'",
    'DOUBLE="quoted \\"inner\\" value"',
    'ESCAPES="line\\nbreak\\ttab"',
    'UNTOUCHED=no-quotes',
  ].join('\n'));
  assert.deepEqual(Object.fromEntries(entries), {
    SINGLE: 'quoted value',
    DOUBLE: 'quoted "inner" value',
    ESCAPES: 'line\nbreak\ttab',
    UNTOUCHED: 'no-quotes',
  });
});

test('loadEnvFileInto never overrides pre-existing environment keys', () => {
  const environment = { EXISTING: 'kept' };
  const applied = loadEnvFileInto(environment, [
    ['EXISTING', 'ignored'],
    ['NEW_KEY', 'applied'],
  ]);
  assert.equal(applied, 1);
  assert.equal(environment.EXISTING, 'kept');
  assert.equal(environment.NEW_KEY, 'applied');
});

test('loadEnvFileInto lets the last duplicate line win inside one file', () => {
  const environment = {};
  const applied = loadEnvFileInto(environment, [
    ['TOKEN', 'first'],
    ['TOKEN', 'second'],
  ]);
  assert.equal(applied, 1);
  assert.equal(environment.TOKEN, 'second');
});

test('selectEnvFile picks the first existing candidate', () => {
  const seen = [];
  const existsImpl = (candidate) => {
    seen.push(candidate);
    return candidate === 'second';
  };
  assert.equal(selectEnvFile(['first', 'second', 'third'], existsImpl), 'second');
  assert.deepEqual(seen, ['first', 'second']);
  assert.equal(selectEnvFile([null, ''], existsImpl), null);
});

test('unquote leaves unquoted and unterminated values intact', () => {
  assert.equal(__test.unquote('plain'), 'plain');
  assert.equal(__test.unquote('"unterminated'), '"unterminated');
  assert.equal(__test.unquote(''), '');
});
