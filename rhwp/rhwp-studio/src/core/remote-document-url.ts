/**
 * 원격 문서 URL 사전 검증 — 확장 viewer 가 Service Worker 정책 없이
 * 직접 fetch 하는 경로를 막기 위한 클라이언트 측 게이트.
 *
 * rhwp-shared/sw/private-network.js (확장 SW) 와 동일한 규칙을 적용한다:
 * http(s) 만 허용, userinfo 차단, 사설·내부망 주소 차단.
 */

export class RemoteDocumentUrlError extends Error {
  reason: string;

  constructor(reason: string, message?: string) {
    super(message ?? reason);
    this.name = 'RemoteDocumentUrlError';
    this.reason = reason;
  }
}

function isPrivateIPv4(host: string): boolean {
  const parts = host.split('.').map(Number);
  if (parts.some((part) => part < 0 || part > 255)) return true;
  const [a, b] = parts;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    a >= 224
  );
}

/** IPv6 리터럴을 8개의 16비트 그룹으로 펼친다. 잘못된 리터럴은 null. */
function expandIPv6(host: string): number[] | null {
  let text = host.toLowerCase();
  const zone = text.indexOf('%');
  if (zone >= 0) text = text.slice(0, zone);

  const lastColon = text.lastIndexOf(':');
  const tail = lastColon >= 0 ? text.slice(lastColon + 1) : '';
  let tailGroups: number[] = [];
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(tail)) {
    tailGroups = tail.split('.').map(Number);
    if (tailGroups.some((n) => n < 0 || n > 255)) return null;
    text = text.slice(0, lastColon + 1);
    if (!text.endsWith('::')) text = text.slice(0, -1);
  }

  const doubleColon = text.indexOf('::');
  let groups: string[];
  if (doubleColon >= 0) {
    if (text.indexOf('::', doubleColon + 1) >= 0) return null;
    const left = text.slice(0, doubleColon);
    const right = text.slice(doubleColon + 2);
    const leftGroups = left ? left.split(':') : [];
    const rightGroups = right ? right.split(':') : [];
    const fill = 8 - leftGroups.length - rightGroups.length - Math.floor(tailGroups.length / 2);
    if (fill < 0) return null;
    groups = [...leftGroups, ...Array.from({ length: fill }, () => '0'), ...rightGroups];
  } else {
    groups = text.split(':').filter((group) => group !== '');
  }

  const out: number[] = [];
  for (const group of groups) {
    if (!/^[0-9a-f]{1,4}$/.test(group)) return null;
    out.push(parseInt(group, 16));
  }
  for (let i = 0; i < tailGroups.length; i += 2) {
    out.push((tailGroups[i] << 8) | tailGroups[i + 1]);
  }
  return out.length === 8 ? out : null;
}

function isPrivateIPv6(host: string): boolean {
  if (!host.includes(':')) return false;
  const groups = expandIPv6(host);
  if (!groups) return true;
  const high = (i: number) => groups[i] >> 8;
  const low = (i: number) => groups[i] & 0xff;

  if (groups.every((g) => g === 0)) return true;
  if (groups.slice(0, 7).every((g) => g === 0) && groups[7] === 1) return true;
  if (groups.slice(0, 5).every((g) => g === 0) && groups[5] === 0xffff) {
    return isPrivateIPv4(`${high(6)}.${low(6)}.${high(7)}.${low(7)}`);
  }
  if (groups.slice(0, 3).every((g) => g === 0) && groups[3] === 0 && groups[4] === 0 && groups[5] === 0) {
    return true;
  }
  if (groups[0] === 0x0064 && groups[1] === 0xff9b && groups.slice(2, 6).every((g) => g === 0)) {
    return isPrivateIPv4(`${high(6)}.${low(6)}.${high(7)}.${low(7)}`);
  }
  if ((groups[0] & 0xffc0) === 0xfe80) return true;
  if ((groups[0] & 0xfe00) === 0xfc00) return true;
  if (groups[0] === 0x0100 && groups.slice(1, 4).every((g) => g === 0)) return true;
  if ((groups[0] & 0xff00) === 0xff00) return true;
  return false;
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

  const host = parsed.hostname.toLowerCase().replace(/\.$/, '').replace(/^\[/, '').replace(/\]$/, '');
  if (!host) throw new RemoteDocumentUrlError('private-host-blocked', '호스트가 비어 있습니다.');
  if (host === 'localhost') {
    throw new RemoteDocumentUrlError('private-host-blocked', '로컬 또는 내부 네트워크 URL은 차단됩니다.');
  }
  const BLOCKED_SUFFIXES = ['.localhost', '.local', '.localdomain', '.internal', '.intranet', '.lan', '.home', '.corp'];
  if (BLOCKED_SUFFIXES.some((suffix) => host.endsWith(suffix))) {
    throw new RemoteDocumentUrlError('private-host-blocked', '로컬 또는 내부 네트워크 URL은 차단됩니다.');
  }
  if (host.includes(':')) {
    if (isPrivateIPv6(host)) {
      throw new RemoteDocumentUrlError('private-host-blocked', '로컬 또는 내부 네트워크 URL은 차단됩니다.');
    }
  } else if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host)) {
    if (isPrivateIPv4(host)) {
      throw new RemoteDocumentUrlError('private-host-blocked', '로컬 또는 내부 네트워크 URL은 차단됩니다.');
    }
  } else if (!host.includes('.')) {
    // 단일 라벨 호스트는 대부분 인트라넷 이름이다.
    throw new RemoteDocumentUrlError('private-host-blocked', '로컬 또는 내부 네트워크 URL은 차단됩니다.');
  }

  return parsed;
}
