// rhwp 보안 상수 — Chrome/Safari 공통
'use strict';

/** 기본 허용 도메인 (공공/교육/군사) */
const DEFAULT_ALLOWED_DOMAINS = [
  '.go.kr',
  '.or.kr',
  '.ac.kr',
  '.mil.kr',
  '.korea.kr',
  '.sc.kr',
];

/** HWP 파일 확장자 */
const HWP_EXTENSIONS = /\.(hwp|hwpx)(\?.*)?$/i;

/** HWP 파일 매직 넘버 */
const HWP_MAGIC = [0xD0, 0xCF, 0x11, 0xE0];  // OLE2 (HWP 5.0)
const HWPX_MAGIC = [0x50, 0x4B, 0x03, 0x04];  // ZIP (HWPX)

/** 허용 프로토콜 */
const ALLOWED_PROTOCOLS = ['https:', 'http:'];

/** 차단할 내부 네트워크 IP 패턴 */
const PRIVATE_IP_PATTERNS = [
  /^127\./,
  /^10\./,
  /^192\.168\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^169\.254\./,
  /^0\./,
  /^\[::1\]/,
  /^localhost$/i,
  /\.local$/i,
];

/** 차단할 응답 Content-Type */
const BLOCKED_CONTENT_TYPES = [
  'text/html',
  'application/json',
  'application/javascript',
  'text/javascript',
];

/** 기본 최대 파일 크기 (바이트) */
const DEFAULT_MAX_FILE_SIZE = 20 * 1024 * 1024; // 20MB

/** 파일명 허용 문자 (영숫자, 한글, 기본 기호) */
const SAFE_FILENAME_RE = /[^a-zA-Z0-9가-힣ㄱ-ㅎㅏ-ㅣ.\-_ ]/g;

/** 파일명 최대 길이 */
const MAX_FILENAME_LENGTH = 255;

/** 텍스트 최대 길이 (호버 카드 XSS 방어) */
const MAX_TEXT_LENGTHS = {
  title: 200,
  description: 500,
  author: 100,
  category: 50,
  filename: 255,
};

// CommonJS / ES module 호환
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    DEFAULT_ALLOWED_DOMAINS, HWP_EXTENSIONS, HWP_MAGIC, HWPX_MAGIC,
    ALLOWED_PROTOCOLS, PRIVATE_IP_PATTERNS, BLOCKED_CONTENT_TYPES,
    DEFAULT_MAX_FILE_SIZE, SAFE_FILENAME_RE, MAX_FILENAME_LENGTH, MAX_TEXT_LENGTHS,
  };
}
