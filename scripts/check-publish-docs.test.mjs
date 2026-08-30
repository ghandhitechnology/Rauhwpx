import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  assertNoHardcodedMcpCount,
  checkPublishDocs,
  hardcodedMcpCountClaims,
} from './check-publish-docs.mjs';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));

test('matching MCP tool counts in publish docs still fail', () => {
  assert.deepEqual(hardcodedMcpCountClaims('The live list is 76 MCP tools today.'), [76]);
  assert.deepEqual(hardcodedMcpCountClaims('도구는 정확히 76개이며 검사한다.'), [76]);
  assert.deepEqual(hardcodedMcpCountClaims('현재 76개 MCP 도구를 제공한다.'), [76]);
  assert.deepEqual(hardcodedMcpCountClaims('See rhwp/rhwp-agent/tools.mjs for the live list.'), []);
});

test('assertNoHardcodedMcpCount fails even when the number matches tools.mjs', () => {
  const live = checkPublishDocs({ root: ROOT });
  assert.equal(live.failures.length, 0, live.failures.join('\n'));
  assert.ok(live.toolCount >= 1);

  assert.throws(
    () => assertNoHardcodedMcpCount('README.md', `There are ${live.toolCount} MCP tools.`),
    (error) => {
      assert.match(String(error.message), new RegExp(`README.md hardcodes MCP tool count: ${live.toolCount}`));
      return true;
    },
  );
});
