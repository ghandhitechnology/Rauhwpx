import { parseConfig } from './config.mjs';
import { createCloudRuntime } from './runtime.mjs';

const config = parseConfig();
const runtime = createCloudRuntime(config);
console.log(JSON.stringify({ event: 'cloud.starting', providers: config.startupProviders }));
try {
  const started = await runtime.start();
  console.log(JSON.stringify({ event: 'cloud.started', ...started }));
} catch (error) {
  console.error(JSON.stringify({
    event: 'cloud.start_failed',
    message: error.message,
    code: error.code,
  }));
  process.exit(1);
}

let stopping = false;
async function stop(signal) {
  if (stopping) return;
  stopping = true;
  console.log(JSON.stringify({ event: 'cloud.stopping', signal }));
  await runtime.stop();
}

function shutdown(signal) {
  stop(signal).then(
    () => process.exit(0),
    (error) => {
      console.error(JSON.stringify({
        event: 'cloud.stop_failed',
        signal,
        message: error.message,
        code: error.code,
        details: error.details,
      }));
      process.exit(1);
    },
  );
}
process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));
