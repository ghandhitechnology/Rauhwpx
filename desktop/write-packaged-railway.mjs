import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { packagedRailwayRecord, railwayConfigFromEnv } from './cloud-railway.mjs';

const directory = dirname(fileURLToPath(import.meta.url));
const config = railwayConfigFromEnv(process.env);
const record = packagedRailwayRecord(config);
if (process.env.RAUHWpx_REQUIRE_PACKAGED_RAILWAY === '1' && !record.token) {
  throw new Error('Official desktop builds require RAUHWpx_RAILWAY_TOKEN, RAUHWpx_RAILWAY_PROJECT_ID, and RAUHWpx_RAILWAY_ENVIRONMENT_ID.');
}
writeFileSync(join(directory, 'packaged-railway.json'), `${JSON.stringify(record, null, 2)}\n`);
