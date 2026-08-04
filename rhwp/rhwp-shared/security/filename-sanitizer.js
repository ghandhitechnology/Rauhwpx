// rhwp 파일명 새니타이즈 모듈 — Chrome/Safari 공통
'use strict';

/**
 * 파일명을 안전하게 새니타이즈한다.
 * - 경로 구분자, 제어문자, 특수문자 제거
 * - path traversal (../../), null byte (%00) 차단
 * - 유니코드 정규화 (NFC)
 * - 255자 제한
 *
 * @param {string} filename
 * @returns {string} 새니타이즈된 파일명
 */
function sanitizeFilename(filename) {
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

  // 허용 문자만 유지: 영숫자, 한글, 기본 기호
  safe = safe.replace(/[^a-zA-Z0-9가-힣ㄱ-ㅎㅏ-ㅣ.\-_ ]/g, '');

  // 앞뒤 공백/점 제거
  safe = safe.replace(/^[\s.]+|[\s.]+$/g, '');

  // 길이 제한
  if (safe.length > 255) {
    safe = safe.slice(0, 255);
  }

  return safe || 'document';
}

/**
 * URL에서 파일명을 추출한다.
 * @param {string} urlString
 * @returns {string}
 */
function extractFilenameFromUrl(urlString) {
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
function extractFilenameFromContentDisposition(headerValue) {
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
