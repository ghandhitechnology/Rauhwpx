import test from 'node:test';
import assert from 'node:assert/strict';
import { fuzzyTemplateScore } from '../src/ui/agent-sidebar/template-fuzzy.ts';

test('template matching ranks prefixes and substrings ahead of ordered characters', () => {
  const prefix = fuzzyTemplateScore('보고서 기본', '보고');
  const substring = fuzzyTemplateScore('월간 보고서', '보고');
  const ordered = fuzzyTemplateScore('분기별 업무 보고서', '분보');
  assert.ok(prefix !== null && substring !== null && ordered !== null);
  assert.ok(prefix > substring);
  assert.ok(substring > ordered);
});

test('template matching normalizes Unicode and supports spaces', () => {
  assert.notEqual(fuzzyTemplateScore('  보고서   기본 ', '보고서 기본'), null);
  assert.notEqual(fuzzyTemplateScore('Résumé', 'rés'), null);
  assert.equal(fuzzyTemplateScore('보고서', '서보'), null);
});
