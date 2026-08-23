// 사설·내부망 IP 판별 — 모든 플랫폼(확장 프로그램 SW, 뷰어, 허브) 공용.
//
// 문자열 prefix 비교는 URL 파서가 축약하는 순간 깨진다:
//   new URL('http://[::ffff:127.0.0.1]/').hostname === '[::ffff:7f00:1]'
// 그래서 호스트명을 항상 16바이트 이진값으로 펼쳐 판정한다.

'use strict';

/** @param {string} host */
function isPrivateIPv4(host) {
  if (!/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host)) return false;
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

/**
 * IPv6 리터럴(괄호 제거 상태)을 8개의 16비트 그룹으로 펼친다.
 * 잘못된 리터럴은 null.
 * @param {string} host
 * @returns {number[] | null}
 */
export function expandIPv6(host) {
  let text = host.toLowerCase();
  const zone = text.indexOf('%');
  if (zone >= 0) text = text.slice(0, zone);

  // IPv4 임베디드 꼬리 (::ffff:127.0.0.1 / ::ffff:ipv4:127.0.0.1)
  const lastColon = text.lastIndexOf(':');
  const tail = lastColon >= 0 ? text.slice(lastColon + 1) : '';
  let tailGroups = [];
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(tail)) {
    tailGroups = tail.split('.').map(Number);
    if (tailGroups.some((n) => n < 0 || n > 255)) return null;
    text = text.slice(0, lastColon + 1);
    if (text.endsWith(':ipv4:')) {
      text = text.slice(0, -'ipv4:'.length);
    }
    // 이미 꼬리를 떼어냈으므로 남은 구분자 하나를 정리한다 (::ffff: → ::ffff)
    if (text.endsWith(':') && !text.endsWith('::')) text = text.slice(0, -1);
  }

  const head = text;
  const doubleColon = head.indexOf('::');
  let groups;
  if (doubleColon >= 0) {
    if (head.indexOf('::', doubleColon + 1) >= 0) return null;
    const left = head.slice(0, doubleColon);
    const right = head.slice(doubleColon + 2);
    const leftGroups = left ? left.split(':') : [];
    const rightGroups = right ? right.split(':') : [];
    const fill = 8 - leftGroups.length - rightGroups.length - Math.floor(tailGroups.length / 2);
    if (fill < 0) return null;
    groups = [
      ...leftGroups,
      ...Array.from({ length: fill }, () => '0'),
      ...rightGroups,
    ];
  } else {
    groups = head.split(':').filter((group) => group !== '');
  }

  const out = [];
  for (const group of groups) {
    if (!/^[0-9a-f]{1,4}$/.test(group)) return null;
    out.push(parseInt(group, 16));
  }
  for (let i = 0; i < tailGroups.length; i += 2) {
    out.push((tailGroups[i] << 8) | tailGroups[i + 1]);
  }
  return out.length === 8 ? out : null;
}

/**
 * 사설·예약·내부망 IPv6 여부. IPv4-mapped(::ffff:a.b.c.d)과
 * NAT64(64:ff9b::/96)는 임베디드 IPv4 규칙으로 다시 판정한다.
 * @param {string} host 괄호 없는 IPv6 리터럴
 */
export function isPrivateIPv6(host) {
  if (!host || !host.includes(':')) return false;
  const groups = expandIPv6(host);
  if (!groups) return true; // 파스 실패한 IPv6 리터럴은 안전 쪽으로 차단

  const high = (i) => groups[i] >> 8;
  const low = (i) => groups[i] & 0xff;

  // :: (all zeros), ::1 (loopback)
  if (groups.every((g) => g === 0)) return true;
  const onlyLastOne = groups.slice(0, 7).every((g) => g === 0) && groups[7] === 1;
  if (onlyLastOne) return true;

  // ::ffff:x.y.z.w → IPv4-mapped: 임베디드 주소에 IPv4 규칙 적용
  if (groups.slice(0, 5).every((g) => g === 0) && groups[5] === 0xffff) {
    const v4 = `${high(6)}.${low(6)}.${high(7)}.${low(7)}`;
    return isPrivateIPv4(v4);
  }
  // 상위 96비트가 0인 나머지 형태(::x.y.z.w IPv4-compatible 포함)
  if (groups.slice(0, 3).every((g) => g === 0) && groups[3] === 0 && groups[4] === 0 && groups[5] === 0) {
    return true;
  }

  // 64:ff9b::/96 (NAT64): 임베디드 IPv4에 규칙 적용
  if (groups[0] === 0x0064 && groups[1] === 0xff9b && groups.slice(2, 6).every((g) => g === 0)) {
    const v4 = `${high(6)}.${low(6)}.${high(7)}.${low(7)}`;
    return isPrivateIPv4(v4);
  }

  // fe80::/10 link-local, fc00::/7 unique-local
  if ((groups[0] & 0xffc0) === 0xfe80) return true;
  if ((groups[0] & 0xfe00) === 0xfc00) return true;
  // 100::/64 discard-only
  if (groups[0] === 0x0100 && groups.slice(1, 4).every((g) => g === 0)) return true;
  // ff00::/8 multicast
  if ((groups[0] & 0xff00) === 0xff00) return true;

  return false;
}

/**
 * URL hostname에서 괄호를 벗기고 소문자로 정규화한다.
 * @param {string} hostname
 */
export function normalizeHost(hostname) {
  return String(hostname || '')
    .toLowerCase()
    .replace(/\.$/, '')
    .replace(/^\[/, '')
    .replace(/\]$/, '');
}

/** URL hostname이 사설·예약·내부망 주소인지 판정한다. */
export function isBlockedHost(hostname, { blockedSuffixes = [], allowSingleLabel = false } = {}) {
  const host = normalizeHost(hostname);
  if (!host) return true;

  if (blockedSuffixes.some((suffix) => host.endsWith(suffix))) return true;

  const isIPv6Literal = host.includes(':');
  if (!isIPv6Literal) {
    if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host)) return isPrivateIPv4(host);
    if (!host.includes('.') && !allowSingleLabel) return true; // 인트라넷 단일 라벨
    return false;
  }
  return isPrivateIPv6(host);
}
