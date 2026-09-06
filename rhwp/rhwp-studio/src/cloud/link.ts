import type { CloudLinkState, CloudSnapshot } from './types.ts';

export const READY_CLOUD_LINK: CloudLinkState = {
  kind: 'ready',
  error: null,
  attempt: 0,
  canRecreate: false,
};

export function inferCloudLink(snapshot: CloudSnapshot): CloudLinkState {
  if (snapshot.link) return snapshot.link;
  const canRecreate = snapshot.profile.kind === 'configured' && snapshot.profile.mode === 'app-hosted';
  if (snapshot.profile.kind === 'configured' && snapshot.profile.connection === 'testing') {
    return { kind: 'reconnecting', error: null, attempt: 0, canRecreate };
  }
  if (snapshot.profile.kind === 'configured' && snapshot.profile.connection === 'error') {
    return { kind: 'failed', error: snapshot.profile.message, attempt: 0, canRecreate };
  }
  return { ...READY_CLOUD_LINK, canRecreate };
}

export function beginCloudReconnect(current: CloudLinkState, canRecreate: boolean): CloudLinkState {
  if (current.kind === 'reconnecting' || current.kind === 'recreating') {
    return { ...current, canRecreate: current.kind === 'recreating' ? true : canRecreate };
  }
  return {
    kind: 'reconnecting',
    error: null,
    attempt: current.attempt + 1,
    canRecreate,
  };
}

export function beginCloudRecreate(current: CloudLinkState): CloudLinkState {
  if (current.kind === 'recreating') return current;
  return {
    kind: 'recreating',
    error: null,
    attempt: current.attempt + 1,
    canRecreate: true,
  };
}

export function markCloudLinkReady(canRecreate: boolean): CloudLinkState {
  return { kind: 'ready', error: null, attempt: 0, canRecreate };
}

export function markCloudLinkFailed(
  current: CloudLinkState,
  error: string,
  canRecreate: boolean,
): CloudLinkState {
  return {
    kind: 'failed',
    error,
    attempt: current.attempt,
    canRecreate,
  };
}

export function shouldAutoRecreate(link: CloudLinkState): boolean {
  return link.canRecreate && link.kind === 'failed' && link.attempt >= 2;
}

export function cloudLinkNeedsAttention(link: CloudLinkState): boolean {
  return link.kind !== 'ready';
}
