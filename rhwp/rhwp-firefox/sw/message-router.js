// Content Script ↔ Service Worker 메시지 라우팅
// - Content Script에서 파일 열기 요청
// - 뷰어 탭에서 파일 fetch 요청 (CORS 우회)
// - 향후: 호버 미리보기, 파일 캐싱 등

import { openViewer } from './viewer-launcher.js';
import {
  isTrustedExtensionPageSender,
  isWebPageSender,
  validateDocumentFetchUrl
} from './fetch-security.js';

function remoteProxyUnavailable() {
  return {
    error: 'Privileged remote fetch is disabled; a server/native fetcher with DNS pinning is required.',
    code: 'REMOTE_PROXY_UNAVAILABLE',
    requirement: 'SERVER_FETCH_REQUIRED'
  };
}

/**
 * 메시지 라우터를 설정한다.
 */
export function setupMessageRouter() {
  browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
    return dispatchRuntimeMessage(message, sender, sendResponse);
  });
}

function safeErrorMessage(error) {
  return error instanceof Error && error.message ? error.message : 'Message handler failed';
}

export function dispatchRuntimeMessage(message, sender, sendResponse) {
  if (!message || typeof message !== 'object' || typeof message.type !== 'string') {
    return false;
  }

  const handler = messageHandlers[message.type];
  if (typeof handler !== 'function') {
    return false;
  }

  try {
    const result = handler(message, sender);
    if (result && typeof result.then === 'function') {
      Promise.resolve(result).then(sendResponse, (error) => {
        sendResponse({ error: safeErrorMessage(error) });
      });
      return true;
    }
    sendResponse(result);
    return false;
  } catch (error) {
    sendResponse({ error: safeErrorMessage(error) });
    return false;
  }
}

export const messageHandlers = {
  /**
   * Content Script → Service Worker: HWP 파일 열기 요청
   * 웹 페이지발 요청은 fetch 정책과 동일한 URL 검증을 통과해야 한다.
   */
  'open-hwp': (message, sender) => {
    if (!isWebPageSender(sender)) {
      return { error: 'Unauthorized sender' };
    }
    try {
      validateDocumentFetchUrl(message.url);
    } catch (err) {
      return { error: err.message };
    }
    openViewer({ url: message.url, filename: message.filename });
    return { ok: true };
  },

  /*
   * Never proxy http(s) from an extension origin. Hostname validation cannot
   * stop DNS rebinding, and browser fetch offers no way to pin the verified IP
   * through every redirect while preserving Host/SNI. A future native/server
   * transport must provide that invariant before this route can be enabled.
   */
  'fetch-file-start': (_message, sender) => {
    if (!isTrustedExtensionPageSender(sender, browser)) {
      return { error: 'Unauthorized sender' };
    }
    return remoteProxyUnavailable();
  },

  'fetch-file-chunk': (_message, sender) => {
    if (!isTrustedExtensionPageSender(sender, browser)) {
      return { error: 'Unauthorized sender' };
    }
    return remoteProxyUnavailable();
  },

  'fetch-file-close': (_message, sender) => {
    if (!isTrustedExtensionPageSender(sender, browser)) {
      return { error: 'Unauthorized sender' };
    }
    return remoteProxyUnavailable();
  },

  /**
   * Content Script → Service Worker: HWP 썸네일 추출
   * Service Worker에서 fetch + CFB PrvImage 추출 (CORS 우회)
   */
  'extract-thumbnail': async (message, sender) => {
    try {
      if (!isWebPageSender(sender)) {
        return { error: 'Unauthorized sender' };
      }
      return remoteProxyUnavailable();
    } catch (err) {
      return { error: err.message };
    }
  },

  /**
   * Content Script → Service Worker: 설정 조회
   */
  'get-settings': async () => {
    const settings = await browser.storage.sync.get({
      autoOpen: true,
      showBadges: true,
      hoverPreview: true,
      disableExternalWebFonts: false
    });
    return settings;
  }
};
