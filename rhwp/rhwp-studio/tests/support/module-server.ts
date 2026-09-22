import { join } from 'node:path';
import { createServer } from 'vite';

/** Load aliased TS modules without the application plugins or an HTTP listener. */
export function createTestModuleServer(root: string) {
  return createServer({
    root,
    configFile: false,
    appType: 'custom',
    logLevel: 'silent',
    resolve: { alias: { '@': join(root, 'src') } },
    server: { middlewareMode: true, hmr: false },
  });
}
