import { parseConfig } from './config.mjs';
import { createCloudRuntime } from './runtime.mjs';

const config = parseConfig();
const runtime = createCloudRuntime(config);
const started = await runtime.start();
console.log(JSON.stringify({ event: 'cloud.started', ...started }));

let stopping = false;
async function stop(signal) {
  if (stopping) return;
  stopping = true;
  console.log(JSON.stringify({ event: 'cloud.stopping', signal }));
  await runtime.stop();
}

process.once('SIGINT', () => { void stop('SIGINT').then(() => process.exit(0)); });
process.once('SIGTERM', () => { void stop('SIGTERM').then(() => process.exit(0)); });
