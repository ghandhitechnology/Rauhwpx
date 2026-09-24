/** Create a local, clickable contact sheet from agent-preview-integrity artifacts. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, process.argv.find(arg => arg.startsWith('--artifacts='))?.slice(12)
  || '../../../output/e2e/agent-preview-integrity');
const manifest = JSON.parse(fs.readFileSync(path.join(here, 'agent-preview-corpus.json'), 'utf8'));
const report = JSON.parse(fs.readFileSync(path.join(root, 'report.json'), 'utf8'));
const escape = value => String(value ?? '').replace(/[&<>"']/g, char =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const safeName = name => name.replace(/[^\p{L}\p{N}.-]+/gu, '_');
const dirs = fs.readdirSync(root, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => entry.name);
const stages = ['baseline', 'mixed-format-pending', 'streaming', 'pending', 'approved',
  'long-pending', 'rejected', 'multiline-pending', 'multiline-rejected',
  'equation-pending', 'equation-rejected', 'image-pending', 'image-rejected', 'failure'];

const selected = report.requested ? [{
  path: report.requested,
  tables: report.inventory?.[0]?.tables ?? 0,
  cells: report.inventory?.[0]?.cells ?? 0,
  requiredTypes: report.inventory?.[0]?.types ?? [],
}] : report.targeted ? manifest.targetedSamples : manifest.samples;
const cards = selected.map((sample, index) => {
  const dir = dirs.find(name => name.endsWith(`-${safeName(sample.path)}`));
  const resultPath = dir && path.join(root, dir, 'result.json');
  const result = resultPath && fs.existsSync(resultPath) ? JSON.parse(fs.readFileSync(resultPath, 'utf8')) : null;
  const status = report.results?.some(item => item.sample === sample.path) ? 'pass'
    : report.failures?.some(item => item.sample === sample.path) ? 'fail' : 'not run';
  const continuationStages = (result?.stages?.['long-pending']?.continuationPages ?? [])
    .map(pageIndex => `long-pending-page-${pageIndex + 1}`);
  if (result?.stages?.['long-pending']?.bottomPage !== undefined) {
    continuationStages.push(`long-pending-page-${result.stages['long-pending'].bottomPage + 1}-bottom`);
  }
  const imageStages = stages.flatMap(stage => stage === 'long-pending'
    ? [stage, ...continuationStages] : [stage]);
  const images = dir ? imageStages.filter(stage => (stage !== 'failure' || status === 'fail')
    && fs.existsSync(path.join(root, dir, `${stage}.png`)))
    .map(stage => `<a class="shot" href="${encodeURI(`${dir}/${stage}.png`)}" target="_blank"><span>${escape(stage)}</span><img loading="lazy" src="${encodeURI(`${dir}/${stage}.png`)}" alt="${escape(sample.path)} ${stage}"></a>`).join('') : '';
  const detail = result?.error || report.failures?.find(item => item.sample === sample.path)?.error || '';
  return `<section class="card ${status}">
    <header><b>${index + 1}. ${escape(sample.path)}</b><strong>${escape(status)}</strong></header>
    <p>${sample.tables} tables · ${sample.cells} cells · ${escape(sample.requiredTypes.join(', '))}${result?.target ? ` · cell ${result.target.cellIdx}, paragraph ${result.target.paragraph}` : ''}</p>
    ${result?.target ? `<p>Edited: ${escape(result.target.original.slice(0, 85))} → ${escape(result.target.sameLengthReplacement.slice(0, 85))} · ${result.target.renderedTextRuns ?? '?'} target text runs</p>` : ''}
    ${result?.stages?.pending?.unpaintedTextLayoutChanged ? '<p>Unpainted space or empty run positions changed during preview.</p>' : ''}
    ${detail ? `<details><summary>Failure details</summary><pre>${escape(detail)}</pre></details>` : ''}
    ${dir ? `<a class="json" href="${encodeURI(`${dir}/result.json`)}">Result JSON</a>` : ''}
    <div class="shots">${images}</div>
  </section>`;
}).join('\n');

const html = `<!doctype html><html lang="en"><meta charset="utf-8"><title>Agent preview integrity</title>
<style>
body{margin:0;padding:24px;background:#f5f5f4;color:#171717;font:14px system-ui,sans-serif}main{max-width:1600px;margin:auto}
h1{font-size:24px;margin:0 0 6px}p{margin:5px 0;color:#555}aside{background:#fff;border:1px solid #ddd;border-radius:8px;padding:12px;margin:16px 0 24px}
.card{background:#fff;border:1px solid #d4d4d4;border-radius:8px;margin:14px 0;padding:14px;overflow:hidden}.card.fail{border-color:#dc2626}
header{display:flex;justify-content:space-between;gap:10px;font-size:16px}strong{font-size:13px;text-transform:uppercase;color:#166534}.fail strong{color:#b91c1c}
.shots{display:flex;gap:10px;overflow:auto;margin-top:12px}.shot{flex:0 0 230px;color:#333;text-decoration:none}.shot span{display:block;margin-bottom:5px;font-size:12px}
.shot img{width:230px;height:170px;object-fit:contain;object-position:top left;background:#e7e5e4;border:1px solid #ddd}
details{margin:8px 0;color:#b91c1c}pre{max-height:200px;overflow:auto;white-space:pre-wrap}.json{font-size:12px}
</style><main><h1>Agent preview integrity</h1>
<p>${escape(report.generatedAt)} · ${report.totals?.passed ?? 0} passed · ${report.totals?.failed ?? 0} failed · ${report.totals?.tables ?? 0} tables · ${report.totals?.cells ?? 0} cells inventoried</p>
<aside>Each row links to full resolution screenshots taken at the edited cell. The same-length edit is checked for all unrelated visible text runs, every rendered control rectangle, cells, and objects. A longer edit and an equation insertion are rejected and checked for exact restoration. Two documents also exercise image insertion and rejection.</aside>
${cards}</main></html>`;
fs.writeFileSync(path.join(root, 'index.html'), html);
console.log(path.join(root, 'index.html'));
