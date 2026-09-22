import { inferCloudLink } from './link.ts';
import type { CloudSessionState, CloudSnapshot } from './types.ts';
import type { CloudWorkspaceBinding, ComposerTarget } from './workspace.ts';

export function canChangeCloudProviderSettings(session: CloudSessionState): boolean {
  if (session.kind === 'idle' || !session.selection || session.configurationPending) return false;
  if (session.kind === 'running') return session.phase === 'waiting' && session.wait === null;
  // Older servers do not support configuring a room without a running worker.
  return session.kind === 'suspended' && session.configurationEditable === true;
}

/** Settings can target a paused room even though its message composer is closed. */
export function cloudProviderSettingsTarget(
  snapshot: CloudSnapshot,
  binding: CloudWorkspaceBinding | null,
  threadId: string,
  composer: ComposerTarget,
): (CloudWorkspaceBinding & { expectedVersion: number }) | null {
  const session = snapshot.session;
  if (inferCloudLink(snapshot).kind !== 'ready' || !binding || session.kind === 'idle'
    || session.threadId !== threadId || binding.sessionId !== session.sessionId
    || binding.threadId !== session.threadId || binding.documentId !== session.documentId
    || !canChangeCloudProviderSettings(session)) return null;
  if (composer.kind !== 'cloud-ready'
    && !(composer.kind === 'cloud-blocked' && composer.reason === 'not-accepting-messages')) return null;
  return { ...binding, expectedVersion: session.version };
}
