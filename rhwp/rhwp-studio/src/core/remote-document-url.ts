/**
 * 원격 문서 URL 사전 검증 — 확장 viewer 가 Service Worker 정책 없이
 * 직접 fetch 하는 경로를 막기 위한 클라이언트 측 게이트.
 *
 * rhwp-shared/sw/private-network.js (확장 SW) 와 동일한 규칙을 적용한다:
 * http(s) 만 허용, userinfo 차단, 사설·내부망 주소 차단.
 */

import {
  DEFAULT_BLOCKED_HOST_SUFFIXES,
  isBlockedHost,
} from '../../../rhwp-shared/sw/private-network.js';

export class RemoteDocumentUrlError extends Error {
  reason: string;

  constructor(reason: string, message?: string) {
    super(message ?? reason);
    this.name = 'RemoteDocumentUrlError';
    this.reason = reason;
  }
}

/**
 * 뷰어가 직접 fetch 해도 되는 공개 URL 인지 판정한다.
 * 통과하지 못하면 RemoteDocumentUrlError 를 던진다.
 */
export function validateRemoteDocumentUrl(rawUrl: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new RemoteDocumentUrlError('invalid-url', 'URL 형식이 올바르지 않습니다.');
  }

  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new RemoteDocumentUrlError('scheme-blocked', `허용되지 않은 URL scheme입니다: ${parsed.protocol}`);
  }
  if (parsed.username || parsed.password) {
    throw new RemoteDocumentUrlError('userinfo-blocked', '사용자 정보가 포함된 URL은 차단됩니다.');
  }

  if (isBlockedHost(parsed.hostname, { blockedSuffixes: DEFAULT_BLOCKED_HOST_SUFFIXES })) {
    throw new RemoteDocumentUrlError('private-host-blocked', '로컬 또는 내부 네트워크 URL은 차단됩니다.');
  }

  return parsed;
}
