import path from 'node:path';

// The Cloud worker places only user-supplied references in these two directories.
// Keep provider file access narrower than the session workspace, which also
// contains credentials and document checkpoints.
export function cloudReferenceRoots(workRoot, environment = process.env) {
  if (environment.RAUHWpx_CLOUD_RUNTIME !== '1') return [];
  const resolved = path.resolve(workRoot);
  if (path.basename(resolved) !== 'agent-work') {
    throw new Error('Cloud agent work root must be the session agent-work directory');
  }
  const workspace = path.dirname(resolved);
  return [
    path.join(workspace, 'input'),
    path.join(workspace, 'follow-up-attachments'),
  ];
}
