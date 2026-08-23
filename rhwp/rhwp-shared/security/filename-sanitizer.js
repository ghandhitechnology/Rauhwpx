// rhwp 파일명 새니타이즈 모듈 — Chrome/Safari 공통
'use strict';

// Windows 예약 장치명 — 확장자 유무와 관계없이 파일명으로 쓸 수 없다.
const WINDOWS_RESERVED_NAMES = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i;

/**
 * 파일명을 안전하게 새니타이즈한다.
 * - 경로 구분자, 제어문자, 특수문자 제거
 * - path traversal (../../), null byte (%00) 차단
 * - 유니코드 정규화 (NFC)
 * - Windows 예약 장치명 회피
 * - 255바이트 제한 (UTF-8 기준)
 *
 * @param {string} filename
 * @returns {string} 새니타이즈된 파일명
 */
export function sanitizeFilename(filename) {
  if (!filename || typeof filename !== 'string') return '';

  let safe = filename;

  // 유니코드 정규화 (homoglyph 방어)
  if (typeof safe.normalize === 'function') {
    safe = safe.normalize('NFC');
  }

  // URL 디코딩 (double encoding 방어: %2527 → %27 → ')
  try {
    safe = decodeURIComponent(safe);
    // 2차 디코딩 시도 (double encoding)
    try { safe = decodeURIComponent(safe); } catch { /* 무시 */ }
  } catch { /* 이미 디코딩됨 */ }

  // null byte 제거
  safe = safe.replace(/\0/g, '');

  // path traversal 제거
  safe = safe.replace(/\.\./g, '');

  // 경로 구분자 제거
  safe = safe.replace(/[/\\]/g, '_');

  // 제어문자 제거
  safe = safe.replace(/[\u0000-\u001f\u007f]/g, '');

  // 허용 문자만 유지: 영숫자, 한글, 기본 기호
  safe = safe.replace(/[^a-zA-Z0-9가-힣ㄱ-ㅎㅏ-ㅣ.\-_ ]/g, '');

  // 앞뒤 공백/점 제거
  safe = safe.replace(/^[\s.]+|[\s.]+$/g, '');

  // 길이 제한 — UTF-8 바이트 기준 255바이트 (한글 파일명 대비)
  const encoder = new TextEncoder();
  while (encoder.encode(safe).length > 255 && safe.length > 1) {
    safe = safe.slice(0, -1);
  }

  // Windows 예약 장치명(CON, NUL, COM1...)은 앞에 안전한 접두사를 붙인다.
  const base = safe.includes('.') ? safe.slice(0, safe.indexOf('.')) : safe;
  if (WINDOWS_RESERVED_NAMES.test(base)) {
    safe = `_${safe}`;
  }

  return safe || 'document';
}

/**
 * URL에서 파일명을 추출한다.
 * @param {string} urlString
 * @returns {string}
 */
export function extractFilenameFromUrl(urlString) {
  try {
    const parsed = new URL(urlString);
    const pathname = decodeURIComponent(parsed.pathname);
    const name = pathname.split('/').pop() || '';
    if (/\.(hwp|hwpx)$/i.test(name)) {
      return sanitizeFilename(name);
    }
  } catch { /* 무시 */ }
  return '';
}

/**
 * Content-Disposition 헤더에서 파일명을 추출한다.
 * @param {string} headerValue — Content-Disposition 헤더 값
 * @returns {string|null}
 */
export function extractFilenameFromContentDisposition(headerValue) {
  if (!headerValue) return null;

  // filename*=UTF-8''... (RFC 5987)
  const utf8Match = headerValue.match(/filename\*\s*=\s*(?:UTF-8|utf-8)''(.+?)(?:;|$)/i);
  if (utf8Match) {
    try {
      return sanitizeFilename(decodeURIComponent(utf8Match[1]));
    } catch { /* fall through */ }
  }

  // filename="..." 또는 filename=...
  const match = headerValue.match(/filename\s*=\s*"?([^";\n]+)"?/i);
  if (match) {
    return sanitizeFilename(match[1].trim());
  }

  return null;
}

// 내보내기
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { sanitizeFilename, extractFilenameFromUrl, extractFilenameFromContentDisposition };
}
