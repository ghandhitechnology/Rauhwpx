import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import test from 'node:test';

import puppeteer, { type Browser, type Page } from 'puppeteer-core';
import { createServer, type ViteDevServer } from 'vite';

const BROWSER_CANDIDATES = [
  process.env.PUPPETEER_EXECUTABLE_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].filter((candidate): candidate is string => Boolean(candidate));

const executablePath = BROWSER_CANDIDATES.find(existsSync);
const studioRoot = fileURLToPath(new URL('../', import.meta.url));
let server: ViteDevServer | null = null;
let browser: Browser | null = null;
let baseUrl = '';

test.before(async () => {
  if (!executablePath) return;
  server = await createServer({
    root: studioRoot,
    configFile: false,
    cacheDir: resolve(studioRoot, 'node_modules/.vite-version-manager-browser-test'),
    logLevel: 'silent',
    server: {
      host: '127.0.0.1',
      port: 0,
      hmr: false,
      fs: { allow: [studioRoot] },
    },
  });
  await server.listen();
  const address = server.httpServer?.address();
  assert.ok(address && typeof address !== 'string');
  baseUrl = `http://127.0.0.1:${address.port}`;
  browser = await puppeteer.launch({
    executablePath,
    headless: true,
    args: process.env.CI || process.env.DEPOT_JOB_URL
      ? ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
      : [],
  });
});

test.after(async () => {
  await browser?.close();
  await server?.close();
});

async function openPage(context: test.TestContext): Promise<Page | null> {
  if (!browser) {
    context.skip('Chrome or Chromium is unavailable');
    return null;
  }
  const page = await browser.newPage();
  await page.setViewport({ width: 900, height: 820, deviceScaleFactor: 1 });
  await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
  await page.goto(`${baseUrl}/tests/fixtures/version-store-idb.html`);
  await page.evaluate(async () => {
    const [{ createVersionManagerPage }, graphLayout] = await Promise.all([
      import('/src/ui/agent-sidebar/version-manager.ts'),
      import('/src/versioning/graph-layout.ts'),
    ]);
    const now = new Date(2026, 7, 24, 13, 5).getTime();
    const branches = [
      { name: 'main', headId: 'main3', isActive: false, isDefault: true, updatedAt: now - 4_000 },
      { name: 'feature', headId: 'merge5', isActive: true, isDefault: false, updatedAt: now },
      { name: 'docs', headId: 'docs3', isActive: false, isDefault: false, updatedAt: now - 3_000 },
      { name: 'hotfix', headId: 'shared6', isActive: false, isDefault: false, updatedAt: now - 1_000 },
      { name: 'release', headId: 'shared6', isActive: false, isDefault: false, updatedAt: now - 1_000 },
    ];
    const graphCommits = [
      { id: 'merge5', ordinal: 8, parents: ['feature4', 'docs3'] },
      { id: 'shared6', ordinal: 7, parents: ['root1'] },
      { id: 'feature4', ordinal: 6, parents: ['main2'] },
      { id: 'docs3', ordinal: 5, parents: ['root1'] },
      { id: 'main3', ordinal: 4, parents: ['main2'] },
      { id: 'main2', ordinal: 2, parents: ['root1'] },
      { id: 'root1', ordinal: 1, parents: [] },
    ];
    const preferredHeads = graphLayout.orderBranchHeadFrontier(
      branches.map((branch) => ({ name: branch.name, target: branch.headId })),
      'main',
      'feature',
    );
    const rows = graphLayout.layoutCommitGraph(graphCommits, [], preferredHeads);
    const branchLabels = (id: string) => branches
      .filter((branch) => branch.headId === id)
      .map((branch) => branch.name);
    const state = {
      documentId: 'branch-browser-test',
      documentName: 'branch-browser-test.hwpx',
      saved: true,
      enabled: true,
      dirty: false,
      mutationBlockedReason: null as string | null,
      activeBranch: 'feature',
      commits: rows.map((row, index) => ({
        id: row.commitId,
        shortId: row.commitId.padEnd(8, '0').slice(0, 8),
        title: row.commitId === 'merge5' ? 'Merge docs into feature' : `Checkpoint ${row.commitId}`,
        createdAt: now - index * 60_000,
        reason: row.commitId === 'merge5' ? 'merge' : 'manual',
        parentIds: graphCommits.find((commit) => commit.id === row.commitId)?.parents ?? [],
        branchLabels: branchLabels(row.commitId),
        tagLabels: [],
        lane: row.lane,
        laneCount: row.laneCount,
        startsLane: row.startsLane,
        lanesBefore: [...row.lanesBefore],
        lanesAfter: [...row.lanesAfter],
        activeLanesBefore: [...row.activeLanesBefore],
        parentLanes: row.edges.map((edge) => edge.toLane),
        isHead: row.commitId === 'merge5',
        byteLength: 1_024,
      })),
      branches,
      shelves: [],
      mergeDrafts: [],
      legacy: [],
      hasMoreCommits: false,
      loading: false,
      storageBytes: 8_192,
      storageQuotaBytes: null,
      aiTitlesEnabled: false,
    };
    const calls: string[][] = [];
    let listener = (_next: typeof state) => undefined;
    const noOp = async () => undefined;
    const controller = {
      getState: () => state,
      refresh: noOp,
      subscribe: (next: typeof listener) => {
        listener = next;
        return () => undefined;
      },
      enable: noOp,
      checkpoint: async (message?: string) => {
        const priorHead = state.commits[0];
        priorHead.isHead = false;
        priorHead.branchLabels = [];
        state.commits.unshift({
          ...priorHead,
          id: 'newest7',
          shortId: 'newest7',
          title: message || 'Newest checkpoint',
          createdAt: Date.now(),
          parentIds: [priorHead.id],
          branchLabels: ['feature'],
          isHead: true,
        });
        listener(state);
      },
      loadMore: noOp,
      restore: noOp,
      adopt: noOp,
      compare: noOp,
      amendTitle: noOp,
      createBranch: noOp,
      switchBranch: async (name: string) => { calls.push(['switch', name]); },
      renameBranch: noOp,
      deleteBranch: noOp,
      startMerge: async (name: string) => { calls.push(['merge', name]); },
      resumeMerge: noOp,
      discardMergeDraft: noOp,
      createTag: noOp,
      createShelf: noOp,
      applyShelf: noOp,
      deleteShelf: noOp,
      compareLegacy: noOp,
      setAiTitlesEnabled: () => undefined,
      collectGarbage: noOp,
    };
    const manager = createVersionManagerPage(controller);
    document.documentElement.style.background = '#19191d';
    document.body.style.margin = '0';
    manager.element.style.width = '100vw';
    manager.element.style.height = '800px';
    manager.element.setAttribute('aria-hidden', 'false');
    manager.element.inert = false;
    document.body.replaceChildren(manager.element);
    manager.open();
    Object.assign(window, {
      __versionManagerHarness: {
        calls,
        close: () => manager.close(),
        dispose: () => manager.dispose(),
        setBlocked(reason: string | null) {
          state.mutationBlockedReason = reason;
          listener(state);
        },
      },
    });
  });
  return page;
}

test('closing the page cancels an open merge prompt before it can start work', async (context) => {
  const page = await openPage(context);
  if (!page) return;
  try {
    await page.click('.ag-versions-toolbar [data-version-mutation]');
    await page.waitForSelector('.ag-version-prompt-overlay');
    await page.evaluate(() => (window as any).__versionManagerHarness.close());
    assert.equal(await page.$('.ag-version-prompt-overlay'), null);
    assert.deepEqual(await page.evaluate(() => (window as any).__versionManagerHarness.calls), []);
  } finally {
    await page.close();
  }
});

test('branch graph stays operable, directional, locked, and responsive', async (context) => {
  const page = await openPage(context);
  if (!page) return;
  try {
    assert.equal(await page.$eval('[data-tab="history"]', (node) => node.textContent), '그래프');
    assert.equal(await page.$eval('[data-commit-id="merge5"]', (node) => node.getAttribute('aria-selected')), 'true');
    assert.match(
      await page.$eval('[data-commit-id="merge5"]', (node) => node.getAttribute('aria-label') ?? ''),
      /HEAD feature/,
    );
    assert.equal(await page.$eval('.ag-versions-branch-pill', (node) => node.getAttribute('aria-label')), '현재 브랜치 feature 보기');
    const toolbarMerge = '.ag-versions-toolbar [data-version-mutation]';
    assert.equal(await page.$eval(toolbarMerge, (node) => node.textContent), '병합: … → feature');
    assert.equal(await page.$eval(toolbarMerge, (node) => node.getAttribute('title')), '병합: 다른 브랜치 → feature');
    assert.equal(await page.$eval(toolbarMerge, (node) => node.getAttribute('aria-label')), '병합: 다른 브랜치 → feature');
    await page.click(toolbarMerge);
    await page.type('.ag-version-prompt-input', 'docs');
    await page.click('.ag-version-prompt-actions .ag-versions-primary');
    await page.waitForFunction(() => (window as any).__versionManagerHarness.calls.length === 1);
    assert.deepEqual(await page.evaluate(() => (window as any).__versionManagerHarness.calls), [['merge', 'docs']]);

    await page.click('[data-commit-id="docs3"]');
    await page.keyboard.press('ArrowDown');
    assert.equal(await page.$eval('.ag-version-row.ag-selected', (node) => node.getAttribute('data-commit-id')), 'main3');
    await page.keyboard.press('Home');
    assert.equal(await page.$eval('.ag-version-row.ag-selected', (node) => node.getAttribute('data-commit-id')), 'merge5');
    await page.keyboard.press('End');
    assert.equal(await page.$eval('.ag-version-row.ag-selected', (node) => node.getAttribute('data-commit-id')), 'root1');
    assert.equal(await page.$eval('.ag-version-row.ag-selected', (node) => node.getAttribute('tabindex')), '0');

    await page.click('[data-tab="branches"]');
    const docsMerge = '[data-branch-name="docs"] [data-version-action="merge"]';
    assert.equal(await page.$eval(docsMerge, (node) => node.textContent), '병합: docs → feature');
    assert.equal(await page.$eval(docsMerge, (node) => node.getAttribute('title')), '병합: docs → feature');
    assert.equal(await page.$eval(docsMerge, (node) => node.getAttribute('aria-label')), 'docs에서 feature로 병합');
    await page.click(docsMerge);
    await page.click('[data-branch-name="hotfix"] [data-version-action="switch"]');
    await page.waitForFunction(() => (window as any).__versionManagerHarness.calls.length === 3);
    assert.deepEqual(await page.evaluate(() => (window as any).__versionManagerHarness.calls), [
      ['merge', 'docs'],
      ['merge', 'docs'],
      ['switch', 'hotfix'],
    ]);
    assert.equal(await page.$('[data-branch-name="main"] [data-version-action="delete"]'), null);
    assert.equal(await page.$('[data-branch-name="feature"] [data-version-action="delete"]'), null);

    await page.evaluate(() => (window as any).__versionManagerHarness.setBlocked('병합 검토 중'));
    const locked = await page.$$eval('[data-version-mutation]', (buttons) => (
      buttons.length > 0 && buttons.every((button) => (button as HTMLButtonElement).disabled)
    ));
    assert.equal(locked, true);
    assert.equal(await page.$eval('.ag-versions-branch-pill', (node) => (node as HTMLButtonElement).disabled), false);
    await page.evaluate(() => (window as any).__versionManagerHarness.setBlocked(null));
    await page.click('[data-tab="history"]');

    for (const width of [280, 480, 900]) {
      await page.setViewport({ width, height: 820, deviceScaleFactor: 1 });
      const geometry = await page.evaluate(() => {
        const panel = document.querySelector<HTMLElement>('.ag-versions-page')!;
        const rows = [...document.querySelectorAll<HTMLElement>('.ag-version-row')];
        const panelRect = panel.getBoundingClientRect();
        const mainRef = [...document.querySelectorAll<HTMLElement>('.ag-version-graph-refs .ag-version-ref')]
          .find((ref) => ref.textContent === 'main');
        const mainGraph = mainRef?.closest<HTMLElement>('.ag-version-lane-graph');
        const refRect = mainRef?.getBoundingClientRect();
        const graphRect = mainGraph?.getBoundingClientRect();
        return {
          documentOverflow: document.documentElement.scrollWidth > window.innerWidth,
          panelOverflow: panel.scrollWidth > panel.clientWidth,
          rowsInside: rows.every((row) => row.getBoundingClientRect().right <= panelRect.right + 0.5),
          rowHeights: rows.map((row) => row.getBoundingClientRect().height),
          mainLabelVisible: Boolean(
            mainRef
            && refRect
            && graphRect
            && refRect.width > 0
            && refRect.left >= graphRect.left - 0.5
            && refRect.right <= graphRect.right + 0.5
          ),
          laneCount: document.querySelectorAll('.ag-version-node').length,
        };
      });
      assert.equal(geometry.documentOverflow, false, `${width}px document overflow`);
      assert.equal(geometry.panelOverflow, false, `${width}px panel overflow`);
      assert.equal(geometry.rowsInside, true, `${width}px row overflow`);
      assert.deepEqual([...new Set(geometry.rowHeights)], [44]);
      assert.equal(geometry.mainLabelVisible, true, `${width}px main label is clipped`);
      assert.equal(geometry.laneCount, 7);

      await page.click('[data-tab="branches"]');
      const branchGeometry = await page.evaluate(() => {
        const panel = document.querySelector<HTMLElement>('.ag-versions-branches')!;
        const panelRect = panel.getBoundingClientRect();
        const rows = [...panel.querySelectorAll<HTMLElement>('.ag-versions-ref-row')];
        return {
          panelOverflow: panel.scrollWidth > panel.clientWidth,
          rowsInside: rows.every((row) => row.getBoundingClientRect().right <= panelRect.right + 0.5),
        };
      });
      assert.equal(branchGeometry.panelOverflow, false, `${width}px branch panel overflow`);
      assert.equal(branchGeometry.rowsInside, true, `${width}px branch row overflow`);
      await page.click('[data-tab="history"]');
    }
  } finally {
    await page.close();
  }
});

test('creating a commit selects the new commit and shows its options', async (context) => {
  const page = await openPage(context);
  if (!page) return;
  try {
    await page.click('[data-commit-id="docs3"]');
    assert.equal(
      await page.$eval('.ag-version-row.ag-selected', (node) => node.getAttribute('data-commit-id')),
      'docs3',
    );

    await page.click('button[aria-label="새 커밋 만들기"]');
    await page.type('.ag-version-prompt-input', 'Newest manual commit');
    await page.click('.ag-version-prompt-actions .ag-versions-primary');
    await page.waitForSelector('[data-commit-id="newest7"].ag-selected');

    assert.equal(
      await page.$eval('.ag-version-row.ag-selected', (node) => node.getAttribute('data-commit-id')),
      'newest7',
    );
    assert.equal(
      await page.$eval('.ag-versions-inspector-title', (node) => node.textContent),
      'Newest manual commit',
    );
    assert.ok(await page.$('.ag-versions-inspector-actions'));
  } finally {
    await page.close();
  }
});
