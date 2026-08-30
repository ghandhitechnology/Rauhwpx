#!/usr/bin/env node
import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));

export const PUBLISH_DOCS = [
  'README.md',
  'CONTRIBUTING.md',
  'PRODUCT.md',
  'DESIGN.md',
  'AGENTS.md',
  'CLAUDE.md',
  'rhwp/README.md',
  'rhwp/rhwp-agent/README.md',
  'rhwp/rhwp-chrome/README.md',
  'rhwp/rhwp-chrome/PRIVACY.md',
  'rhwp/rhwp-chrome/DEVELOPER_GUIDE.md',
  'rhwp/rhwp-firefox/README.md',
  'rhwp/rhwp-firefox/PRIVACY.md',
  'rhwp/rhwp-vscode/README.md',
];

const LINK_RE = /\[(?:[^\]]*)\]\(([^)]+)\)/g;
const TOOL_NAME_RE = /^\s+name: '([a-z0-9_]+)',$/gm;
export const HARDCODED_TOOL_COUNT_RE =
  /\b(\d+)\s+MCP tools\b|도구는 정확히 (\d+)개|(\d+)\s*개\s*(?:MCP\s*)?도구/gi;

export function toolNamesFromSource(source) {
  return [...source.matchAll(TOOL_NAME_RE)].map((match) => match[1]);
}

export function hardcodedMcpCountClaims(markdown) {
  const re = new RegExp(HARDCODED_TOOL_COUNT_RE.source, HARDCODED_TOOL_COUNT_RE.flags);
  return [...markdown.matchAll(re)].map((hit) => Number(hit[1] || hit[2] || hit[3]));
}

export function assertNoHardcodedMcpCount(rel, markdown) {
  for (const claimed of hardcodedMcpCountClaims(markdown)) {
    assert.fail(`${rel} hardcodes MCP tool count: ${claimed}`);
  }
}

export function relativeTargets(markdown) {
  const targets = [];
  for (const match of markdown.matchAll(LINK_RE)) {
    const raw = match[1].split(/\s+/)[0];
    if (!raw || raw.startsWith('#') || raw.startsWith('mailto:')) continue;
    if (/^[a-z][a-z0-9+.-]*:/i.test(raw)) continue;
    targets.push(raw.split('#')[0]);
  }
  return targets;
}

export function checkPublishDocs(options = {}) {
  const root = options.root ?? ROOT;
  const readRel = (rel) => readFileSync(path.join(root, rel), 'utf8');
  const failures = [];

  function check(label, fn) {
    try {
      fn();
    } catch (error) {
      failures.push(`${label}: ${error.message}`);
    }
  }

  for (const rel of PUBLISH_DOCS) {
    check(`exists ${rel}`, () => {
      const abs = path.join(root, rel);
      assert.ok(existsSync(abs), `missing ${rel}`);
      assert.ok(statSync(abs).isFile(), `${rel} is not a file`);
    });
  }

  const names = toolNamesFromSource(readRel('rhwp/rhwp-agent/tools.mjs'));
  const toolCount = names.length;
  const unique = new Set(names);
  check('tools.mjs tool names', () => {
    assert.ok(toolCount >= 1, 'tools.mjs exported no tool names');
    assert.equal(unique.size, toolCount, 'tools.mjs has duplicate tool names');
  });

  const testSource = readRel('rhwp/rhwp-agent/tests/tools.test.mjs');
  check('tools.test.mjs pins the live count', () => {
    const pin = testSource.match(/도구는 정확히 (\d+)개/);
    assert.ok(pin, 'tools.test.mjs no longer pins the tool count');
    assert.equal(Number(pin[1]), toolCount, `test pins ${pin[1]} tools, tools.mjs has ${toolCount}`);
  });

  for (const rel of PUBLISH_DOCS) {
    const abs = path.join(root, rel);
    if (!existsSync(abs)) continue;
    const markdown = readRel(rel);
    check(`${rel} has no hardcoded MCP tool count`, () => {
      assertNoHardcodedMcpCount(rel, markdown);
    });
    check(`${rel} relative links resolve`, () => {
      const dir = path.dirname(abs);
      for (const target of relativeTargets(markdown)) {
        const dest = path.resolve(dir, target);
        assert.ok(
          dest.startsWith(root),
          `${rel} link escapes the repo: ${target}`,
        );
        assert.ok(existsSync(dest), `${rel} broken link: ${target}`);
      }
    });
  }

  check('README points at CONTRIBUTING', () => {
    assert.match(readRel('README.md'), /CONTRIBUTING\.md/);
  });

  check('agent README defers the tool list', () => {
    assert.match(readRel('rhwp/rhwp-agent/README.md'), /tools\.mjs/);
  });

  return { failures, toolCount, fileCount: PUBLISH_DOCS.length };
}

function isMainModule() {
  const entry = process.argv[1];
  return Boolean(entry) && pathToFileURL(path.resolve(entry)).href === import.meta.url;
}

if (isMainModule()) {
  const { failures, toolCount, fileCount } = checkPublishDocs();
  if (failures.length) {
    console.error(`publish docs check failed (${failures.length})\n`);
    for (const failure of failures) console.error(`- ${failure}`);
    process.exit(1);
  }
  console.log(`publish docs check passed (${fileCount} files, ${toolCount} tools)`);
}
