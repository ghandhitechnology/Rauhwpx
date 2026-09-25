// 고정 문서(dev 전용): RHWP_PINNED_DOC 가 가리키는 문서를 서버 쪽 작업본으로 두고,
// 어느 기기에서 스튜디오를 열든 같은 작업본을 불러와 편집 내용을 그대로 되돌려 쓴다.
// 원본은 건드리지 않는다. 작업본은 output/pinned/ 아래에 한 번 복사해 둔다.
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
import { basename, resolve } from 'path';

const ROUTE = '/__pinned/document';
const MAX_BYTES = 64 * 1024 * 1024;

export function rhwpPinnedDocumentPlugin(studioDir) {
  const source = process.env.RHWP_PINNED_DOC;
  if (!source) return { name: 'rhwp-pinned-document' };

  const fileName = process.env.RHWP_PINNED_DOC_NAME || basename(source);
  const workDir = resolve(studioDir, '..', '..', 'output', 'pinned');
  const workingCopy = resolve(workDir, fileName);

  return {
    name: 'rhwp-pinned-document',
    apply: 'serve',
    config() {
      return { define: { 'import.meta.env.VITE_RHWP_PINNED_DOC': JSON.stringify('1') } };
    },
    configureServer(server) {
      mkdirSync(workDir, { recursive: true });
      if (!existsSync(workingCopy)) copyFileSync(source, workingCopy);

      server.middlewares.use(ROUTE, (req, res) => {
        if (req.method === 'GET') {
          res.setHeader('Content-Type', 'application/octet-stream');
          res.setHeader('Cache-Control', 'no-store');
          res.setHeader('X-Pinned-Name', encodeURIComponent(fileName));
          res.end(readFileSync(workingCopy));
          return;
        }
        if (req.method === 'PUT') {
          const chunks = [];
          let size = 0;
          req.on('data', (chunk) => {
            size += chunk.length;
            if (size > MAX_BYTES) req.destroy();
            else chunks.push(chunk);
          });
          req.on('end', () => {
            if (size === 0) {
              res.statusCode = 400;
              res.end();
              return;
            }
            const tmp = `${workingCopy}.tmp`;
            writeFileSync(tmp, Buffer.concat(chunks));
            renameSync(tmp, workingCopy);
            res.statusCode = 204;
            res.end();
          });
          return;
        }
        res.statusCode = 405;
        res.end();
      });
    },
  };
}
