// rhwp URL 검증 모듈 — Chrome/Safari 공통
'use strict';

/**
 * URL이 안전한 프로토콜인지 검증한다.
 * @param {string} urlString
 * @returns {{ valid: boolean, parsed?: URL, reason?: string }}
 */
function validateProtocol(urlString) {
  if (!urlString || typeof urlString !== 'string') {
    return { valid: false, reason: 'URL이 비어있음' };
  }
  let parsed;
  try {
    parsed = new URL(urlString);
  } catch {
    return { valid: false, reason: 'URL 파싱 실패' };
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return { valid: false, reason: `차단된 프로토콜: ${parsed.protocol}` };
  }
  // userinfo(@) 포함 도메인 차단: https://safe.go.kr@evil.com/
  if (parsed.username || parsed.password) {
    return { valid: false, reason: 'URL에 userinfo(@) 포함' };
  }
  return { valid: true, parsed };
}

/**
 * 호스트가 내부 네트워크 주소인지 검사한다.
 *
 * 문자열 prefix 가 아니라 이진값으로 판정한다 — URL 파서는
 * ::ffff:127.0.0.1 을 [::ffff:7f00:1] 로 축약하므로 prefix 비교로는 못 잡는다.
 * @param {string} hostname
 * @returns {boolean} 내부 주소이면 true
 */
function isPrivateHost(hostname) {
  const host = String(hostname || '')
    .toLowerCase()
    .replace(/\.$/, '')
    .replace(/^\[/, '')
    .replace(/\]$/, '');
  if (!host) return true;
  if (host === 'localhost') return true;

  if (host.includes(':')) {
    // IPv6 리터럴을 16바이트 관점으로 판정 (rhwp-shared/sw/private-network.js 와 동일 규칙)
    return isPrivateIPv6Literal(host);
  }
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host)) {
    const parts = host.split('.').map(Number);
    if (parts.some(part => part < 0 || part > 255)) return true;
    const [a, b] = parts;
    return (
      a === 0 || a === 10 || a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      a >= 224
    );
  }
  // 인트라넷 단일 라벨 / 내부용 접미사
  if (!host.includes('.')) return true;
  return ['.local', '.localdomain', '.internal', '.intranet', '.lan', '.home', '.corp']
    .some(suffix => host.endsWith(suffix));
}

function isPrivateIPv6Literal(host) {
  let text = host;
  const lastColon = text.lastIndexOf(':');
  const tail = lastColon >= 0 ? text.slice(lastColon + 1) : '';
  const tailGroups = [];
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(tail)) {
    tailGroups.push(...tail.split('.').map(Number));
    if (tailGroups.some(n => n < 0 || n > 255)) return true;
    text = text.slice(0, lastColon + 1);
    if (!text.endsWith('::')) text = text.slice(0, -1);
  }

  const doubleColon = text.indexOf('::');
  let groups;
  if (doubleColon >= 0) {
    if (text.indexOf('::', doubleColon + 1) >= 0) return true; // 파스 실패 → 차단
    const left = text.slice(0, doubleColon);
    const right = text.slice(doubleColon + 2);
    const leftGroups = left ? left.split(':') : [];
    const rightGroups = right ? right.split(':') : [];
    const fill = 8 - leftGroups.length - rightGroups.length - Math.floor(tailGroups.length / 2);
    if (fill < 0) return true;
    groups = [...leftGroups, ...Array.from({ length: fill }, () => '0'), ...rightGroups];
  } else {
    groups = text.split(':').filter(group => group !== '');
  }

  const out = [];
  for (const group of groups) {
    if (!/^[0-9a-f]{1,4}$/.test(group)) return true; // 파스 실패 → 차단
    out.push(parseInt(group, 16));
  }
  for (let i = 0; i < tailGroups.length; i += 2) {
    out.push((tailGroups[i] << 8) | tailGroups[i + 1]);
  }
  if (out.length !== 8) return true;

  const high = i => out[i] >> 8;
  const low = i => out[i] & 0xff;
  if (out.every(g => g === 0)) return true; // ::
  if (out.slice(0, 7).every(g => g === 0) && out[7] === 1) return true; // ::1
  if (out.slice(0, 5).every(g => g === 0) && out[5] === 0xffff) { // IPv4-mapped
    return isPrivateHost(`${high(6)}.${low(6)}.${high(7)}.${low(7)}`);
  }
  if (out.slice(0, 3).every(g => g === 0) && out[3] === 0 && out[4] === 0 && out[5] === 0) return true;
  if (out[0] === 0x0064 && out[1] === 0xff9b && out.slice(2, 6).every(g => g === 0)) { // NAT64
    return isPrivateHost(`${high(6)}.${low(6)}.${high(7)}.${low(7)}`);
  }
  if ((out[0] & 0xffc0) === 0xfe80) return true; // link-local
  if ((out[0] & 0xfe00) === 0xfc00) return true; // unique-local
  if (out[0] === 0x0100 && out.slice(1, 4).every(g => g === 0)) return true; // discard-only
  if ((out[0] & 0xff00) === 0xff00) return true; // multicast
  return false;
}

/**
 * URL의 pathname에서 HWP/HWPX/HML 확장자를 확인한다.
 * @param {URL} parsed
 * @returns {boolean}
 */
function hasHwpExtension(parsed) {
  const pathname = parsed.pathname.toLowerCase();
  return pathname.endsWith('.hwp') || pathname.endsWith('.hwpx') || pathname.endsWith('.hml');
}

/**
 * 호스트가 허용 도메인 목록에 포함되는지 검사한다.
 * @param {string} hostname
 * @param {string[]} allowedDomains — ['.go.kr', '.ac.kr', ...]
 * @returns {boolean}
 */
function isAllowedDomain(hostname, allowedDomains) {
  return allowedDomains.some(domain => hostname.endsWith(domain));
}

/**
 * URL이 정부사이트 다운로드 패턴인지 검사한다.
 * 확장자 없이 *.do, *Download*, *download* 등의 패턴.
 * @param {URL} parsed
 * @returns {boolean}
 */
function isDownloadEndpoint(parsed) {
  const pathname = parsed.pathname.toLowerCase();
  return /\.(do|action|jsp|aspx|php)$/i.test(pathname)
    || /download/i.test(pathname)
    || /filedown/i.test(pathname)
    || /attach/i.test(pathname);
}

/**
 * open-hwp 용 URL 검증 (3단계).
 * ① pathname에 .hwp/.hwpx/.hml → 즉시 허용
 * ② 허용 도메인 + 다운로드 패턴 → 허용 (viewer에서 재검증)
 * ③ 그 외 → 차단
 *
 * @param {string} urlString
 * @param {string[]} allowedDomains
 * @returns {{ allowed: boolean, reason: string }}
 */
function validateOpenHwpUrl(urlString, allowedDomains) {
  const result = validateProtocol(urlString);
  if (!result.valid) return { allowed: false, reason: result.reason };
  const parsed = result.parsed;

  if (isPrivateHost(parsed.hostname)) {
    return { allowed: false, reason: `내부 IP 차단: ${parsed.hostname}` };
  }

  // ① 확장자 확인
  if (hasHwpExtension(parsed)) {
    return { allowed: true, reason: 'HWP 확장자 확인' };
  }

  // ② 허용 도메인 + 다운로드 패턴
  if (isAllowedDomain(parsed.hostname, allowedDomains)) {
    if (isDownloadEndpoint(parsed)) {
      return { allowed: true, reason: '허용 도메인 다운로드 엔드포인트 (viewer에서 재검증)' };
    }
    // 허용 도메인이지만 다운로드 패턴이 아닌 경우도 허용 (content-script가 HWP 링크로 판별했으므로)
    return { allowed: true, reason: '허용 도메인 (viewer에서 재검증)' };
  }

  // ③ 그 외 차단
  return { allowed: false, reason: `미허용 도메인 + 확장자 없음: ${parsed.hostname}` };
}

/**
 * fetch-file 용 URL 검증.
 * open-hwp 보다 엄격: HTTPS 강제, 내부 IP 차단.
 *
 * @param {string} urlString
 * @param {string[]} allowedDomains
 * @param {boolean} allowHttp — 사용자 설정
 * @returns {{ allowed: boolean, reason: string, upgradedUrl?: string }}
 */
function validateFetchUrl(urlString, allowedDomains, allowHttp) {
  const result = validateProtocol(urlString);
  if (!result.valid) return { allowed: false, reason: result.reason };
  const parsed = result.parsed;

  if (isPrivateHost(parsed.hostname)) {
    return { allowed: false, reason: `내부 IP 차단: ${parsed.hostname}` };
  }

  // HTTPS 강제 (설정에 따라 HTTP 허용)
  if (parsed.protocol === 'http:') {
    if (!allowHttp) {
      return { allowed: false, reason: 'HTTP 차단 (설정에서 비허용)' };
    }
    // HTTP → HTTPS 업그레이드 시도
    const upgraded = urlString.replace(/^http:/, 'https:');
    return { allowed: true, reason: 'HTTP → HTTPS 업그레이드', upgradedUrl: upgraded };
  }

  return { allowed: true, reason: '검증 통과' };
}

// 내보내기
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    validateProtocol, isPrivateHost, hasHwpExtension,
    isAllowedDomain, isDownloadEndpoint,
    validateOpenHwpUrl, validateFetchUrl,
  };
}
