// rhwp 보안 이벤트 로깅 모듈 — Chrome/Safari 공통
'use strict';

const _browser = typeof browser !== 'undefined' ? browser : chrome;
const MAX_LOG_ENTRIES = 100;

/**
 * 보안 이벤트를 기록한다.
 * @param {string} type — 'fetch-blocked' | 'url-blocked' | 'sender-blocked' | 'signature-blocked'
 * @param {string} url — 관련 URL
 * @param {string} reason — 차단 사유
 * @param {string} [sender] — 발신자 정보
 */
async function logSecurityEvent(type, url, reason, sender) {
  try {
    const settings = await _browser.storage.sync.get({ securityLog: false });
    if (!settings.securityLog) return;

    const event = {
      time: new Date().toISOString(),
      type,
      url: (url || '').slice(0, 500),  // URL 길이 제한
      reason,
      sender: sender || '',
    };

    const data = await _browser.storage.local.get({ securityEvents: [] });
    const events = data.securityEvents;
    events.push(event);

    // FIFO: 최근 100건만 유지
    while (events.length > MAX_LOG_ENTRIES) {
      events.shift();
    }

    await _browser.storage.local.set({ securityEvents: events });
  } catch {
    // 로깅 실패는 무시 (보안 로직에 영향 없음)
  }
}

/**
 * 보안 이벤트 로그를 조회한다.
 * @returns {Promise<Array>}
 */
async function getSecurityEvents() {
  try {
    const data = await _browser.storage.local.get({ securityEvents: [] });
    return data.securityEvents;
  } catch {
    return [];
  }
}

/**
 * 보안 이벤트 로그를 초기화한다.
 */
async function clearSecurityEvents() {
  await _browser.storage.local.set({ securityEvents: [] });
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { logSecurityEvent, getSecurityEvents, clearSecurityEvents };
}
