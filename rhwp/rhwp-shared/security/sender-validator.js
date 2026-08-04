// rhwp 메시지 발신자 검증 모듈 — Chrome/Safari 공통
'use strict';

// browser vs chrome 호환
const _browser = typeof browser !== 'undefined' ? browser : chrome;

/**
 * 메시지 발신자가 확장 내부 페이지(viewer.html 등)인지 확인한다.
 * @param {object} sender — runtime.onMessage의 sender 파라미터
 * @returns {boolean}
 */
function isInternalPage(sender) {
  if (!sender || !sender.url) return false;
  const extensionBase = _browser.runtime.getURL('');
  return sender.url.startsWith(extensionBase);
}

/**
 * 메시지 발신자가 content script(탭에서 실행)인지 확인한다.
 * @param {object} sender
 * @returns {boolean}
 */
function isContentScript(sender) {
  return !!(sender && sender.tab && sender.tab.id != null);
}

/**
 * 메시지 유형별 발신자를 검증한다.
 * @param {string} messageType — 메시지 type 필드
 * @param {object} sender
 * @returns {{ allowed: boolean, reason: string }}
 */
function validateSender(messageType, sender) {
  switch (messageType) {
    case 'fetch-file':
      // 내부 페이지(viewer.html)만 허용
      if (!isInternalPage(sender)) {
        return { allowed: false, reason: `fetch-file: 외부 발신자 차단 (${sender?.url || 'unknown'})` };
      }
      return { allowed: true, reason: '내부 페이지 확인' };

    case 'open-hwp':
      // content script만 허용
      if (!isContentScript(sender)) {
        return { allowed: false, reason: `open-hwp: content script가 아닌 발신자 (tab=${sender?.tab?.id})` };
      }
      return { allowed: true, reason: 'content script 확인' };

    case 'get-settings':
      // 민감하지 않은 설정 — 모두 허용
      return { allowed: true, reason: '공개 설정' };

    default:
      return { allowed: false, reason: `알 수 없는 메시지 유형: ${messageType}` };
  }
}

// 내보내기
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { isInternalPage, isContentScript, validateSender };
}
