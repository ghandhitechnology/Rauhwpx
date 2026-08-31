function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const SHELL_CSS = `
:root {
  --bg: #0b0c0f;
  --card: #15161a;
  --line: #292b31;
  --text: #f4f3ef;
  --muted: #8d8e96;
  --soft: #b8b8bf;
  --btn: #27292f;
  --bear: #d4cdc4;
  --focus: #aec3ff;
}
* { box-sizing: border-box; }
html, body { height: 100%; }
body {
  margin: 0;
  display: grid;
  place-items: center;
  padding: 28px 18px;
  background:
    radial-gradient(circle at 50% -42%, rgba(82, 105, 169, 0.065), transparent 38%),
    var(--bg);
  color: var(--text);
  font: 15px/1.45 -apple-system, BlinkMacSystemFont, "Apple SD Gothic Neo", "Malgun Gothic", sans-serif;
}
.wrap { width: min(400px, 100%); }
.brand {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  margin: 0 0 22px;
  color: var(--soft);
  font-size: 13px;
  font-weight: 700;
  letter-spacing: 0.01em;
}
.mark {
  width: 18px;
  height: 18px;
  background: var(--bear);
  -webkit-mask: url("/rau.png") center / contain no-repeat;
  mask: url("/rau.png") center / contain no-repeat;
}
.card {
  width: 100%;
  padding: 28px 24px 24px;
  border: 1px solid #fff;
  border-radius: 16px;
  background: #17181c;
  box-shadow:
    0 0 0 1px rgba(255, 255, 255, 0.16) inset,
    0 18px 50px rgba(0, 0, 0, 0.16);
}
.hero {
  display: grid;
  place-items: center;
  width: 38px;
  height: 38px;
  margin-bottom: 18px;
}
.hero span {
  width: 32px;
  height: 32px;
  background: var(--bear);
  -webkit-mask: url("/rau.png") center / contain no-repeat;
  mask: url("/rau.png") center / contain no-repeat;
}
h1 {
  margin: 0;
  font-size: 28px;
  font-weight: 700;
  letter-spacing: -0.03em;
  line-height: 1.12;
}
p {
  margin: 10px 0 0;
  color: var(--muted);
  font-size: 14px;
  line-height: 1.55;
}
.notice {
  margin-top: 14px;
  color: #e8b4b4;
  font-size: 13px;
}
.pairing {
  margin-top: 16px;
  padding: 12px;
  border: 1px solid var(--line);
  border-radius: 10px;
  color: var(--soft);
  text-align: center;
  font: 700 20px/1.2 ui-monospace, SFMono-Regular, Consolas, monospace;
  letter-spacing: 0.12em;
}
.return-code {
  margin-top: 18px;
  padding: 16px 10px;
  border: 1px solid var(--line);
  border-radius: 10px;
  color: var(--text);
  text-align: center;
  font: 700 24px/1.2 ui-monospace, SFMono-Regular, Consolas, monospace;
  letter-spacing: 0.08em;
}
.stack {
  display: grid;
  gap: 8px;
  margin-top: 26px;
}
.btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 10px;
  min-height: 40px;
  padding: 0 16px;
  border: 0;
  border-radius: 10px;
  background: var(--btn);
  color: var(--text);
  font: inherit;
  font-size: 14px;
  font-weight: 600;
  text-decoration: none;
  cursor: pointer;
}
.btn:active { transform: scale(0.97); }
.btn:focus-visible,
input:focus-visible {
  outline: 2px solid var(--focus);
  outline-offset: 3px;
}
.btn-primary {
  background: var(--text);
  color: #15161a;
}
.btn svg { width: 16px; height: 16px; fill: currentColor; }
.rule {
  display: grid;
  grid-template-columns: 1fr auto 1fr;
  align-items: center;
  gap: 10px;
  margin: 18px 0 4px;
  color: var(--muted);
  font-size: 12px;
}
.rule::before, .rule::after {
  content: "";
  height: 1px;
  background: var(--line);
}
form { display: grid; gap: 8px; }
input {
  width: 100%;
  min-height: 40px;
  padding: 0 12px;
  border: 1px solid var(--line);
  border-radius: 10px;
  background: #101114;
  color: var(--text);
  font: inherit;
  font-size: 14px;
}
input::placeholder { color: #6d6e76; }
.back {
  display: inline-block;
  margin-top: 16px;
  color: var(--soft);
  font-size: 13px;
  font-weight: 600;
  text-decoration: none;
}
.hero-count {
  margin: 18px 0 0;
  color: var(--text);
  font: 700 56px/1.05 -apple-system, BlinkMacSystemFont, "Apple SD Gothic Neo", "Malgun Gothic", sans-serif;
  letter-spacing: -0.04em;
}
`.trim();

function shell({ title, body }) {
  return `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<link rel="icon" href="/rau.png">
<style>${SHELL_CSS}</style>
</head>
<body>
<div class="wrap">
  <div class="brand"><span class="mark" aria-hidden="true"></span>Rauhwpx</div>
  ${body}
</div>
</body>
</html>`;
}

const GOOGLE = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M21.6 12.23c0-.74-.07-1.45-.19-2.13H12v4.03h5.38a4.6 4.6 0 0 1-2 3.02v2.5h3.23c1.89-1.74 2.99-4.3 2.99-7.42Z"/><path d="M12 22c2.7 0 4.97-.9 6.63-2.35l-3.23-2.5c-.9.6-2.05.96-3.4.96-2.61 0-4.82-1.76-5.61-4.13H3.06v2.58A9.99 9.99 0 0 0 12 22Z"/><path d="M6.39 13.98A6.01 6.01 0 0 1 6.08 12c0-.69.12-1.35.31-1.98V7.44H3.06A9.99 9.99 0 0 0 2 12c0 1.61.39 3.14 1.06 4.56l3.33-2.58Z"/><path d="M12 5.89c1.47 0 2.79.5 3.83 1.5l2.87-2.87C16.96 2.91 14.7 2 12 2A9.99 9.99 0 0 0 3.06 7.44l3.33 2.58C7.18 7.65 9.39 5.89 12 5.89Z"/></svg>';
const GITHUB = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2C6.48 2 2 6.58 2 12.26c0 4.52 2.87 8.35 6.84 9.7.5.1.68-.22.68-.49 0-.24-.01-.88-.01-1.73-2.78.62-3.37-1.37-3.37-1.37-.45-1.18-1.11-1.5-1.11-1.5-.91-.64.07-.63.07-.63 1 .07 1.53 1.06 1.53 1.06.89 1.57 2.34 1.12 2.91.85.09-.67.35-1.12.63-1.38-2.22-.26-4.55-1.14-4.55-5.07 0-1.12.39-2.04 1.03-2.76-.1-.26-.45-1.32.1-2.75 0 0 .84-.27 2.75 1.05A9.3 9.3 0 0 1 12 6.84c.85 0 1.71.12 2.51.35 1.91-1.32 2.75-1.05 2.75-1.05.55 1.43.2 2.49.1 2.75.64.72 1.03 1.64 1.03 2.76 0 3.94-2.34 4.8-4.57 5.06.36.32.68.94.68 1.9 0 1.37-.01 2.47-.01 2.81 0 .27.18.6.69.49A10.03 10.03 0 0 0 22 12.26C22 6.58 17.52 2 12 2Z"/></svg>';

export function renderLoginPage({ device, email = '', pairingCode = null, notice = '' }) {
  const id = escapeHtml(device);
  const mail = escapeHtml(email);
  return shell({
    title: 'Rauhwpx',
    body: `
<section class="card">
  <div class="hero"><span></span></div>
  <h1>Rau에 연결</h1>
  ${pairingCode ? `<p>Rauhwpx에 표시된 연결 코드와 같은지 확인하세요.</p><div class="pairing">${escapeHtml(pairingCode)}</div>` : ''}
  ${notice ? `<p class="notice">${escapeHtml(notice)}</p>` : ''}
  <div class="stack">
    <a class="btn" href="/continue?device=${encodeURIComponent(device)}&provider=GoogleOAuth">${GOOGLE}Google로 계속</a>
    <a class="btn" href="/continue?device=${encodeURIComponent(device)}&provider=GitHubOAuth">${GITHUB}GitHub로 계속</a>
  </div>
  <div class="rule">이메일</div>
  <form method="post" action="/login/magic">
    <input type="hidden" name="device" value="${id}">
    <input type="email" name="email" value="${mail}" autocomplete="email" required placeholder="you@studio.dev">
    <button class="btn btn-primary" type="submit">코드 보내기</button>
  </form>
</section>`,
  });
}

export function renderCodePage({ device, email, pairingCode = null, notice = '' }) {
  return shell({
    title: 'Rauhwpx',
    body: `
<section class="card">
  <div class="hero"><span></span></div>
  <h1>코드를 보냈어요</h1>
  <p>${escapeHtml(email)}</p>
  ${pairingCode ? `<div class="pairing">${escapeHtml(pairingCode)}</div>` : ''}
  ${notice ? `<p class="notice">${escapeHtml(notice)}</p>` : ''}
  <form method="post" action="/login/magic/verify" style="margin-top:26px">
    <input type="hidden" name="device" value="${escapeHtml(device)}">
    <input type="hidden" name="email" value="${escapeHtml(email)}">
    <input type="text" name="code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" required placeholder="6자리 코드">
    <button class="btn btn-primary" type="submit">확인</button>
  </form>
  <a class="back" href="/login?device=${encodeURIComponent(device)}">다른 방법으로</a>
</section>`,
  });
}

export function renderDonePage() {
  return shell({
    title: 'Rauhwpx',
    body: `
<section class="card">
  <div class="hero"><span></span></div>
  <h1>연결했어요</h1>
  <p>Rauhwpx로 돌아가면 됩니다.</p>
</section>`,
  });
}

export function renderConfirmPage({ deviceId, pairingCode, confirmationToken }) {
  return shell({
    title: 'Rauhwpx',
    body: `
<section class="card">
  <div class="hero"><span></span></div>
  <h1>이 연결을 확인하세요</h1>
  <p>직접 시작한 Rauhwpx에 아래 코드가 표시될 때만 계속하세요.</p>
  <div class="pairing">${escapeHtml(pairingCode)}</div>
  <p class="notice">다른 사람이 보낸 링크라면 확인하지 마세요.</p>
  <form method="post" action="/v2/device-sessions/${encodeURIComponent(deviceId)}/confirm" style="margin-top:26px">
    <input type="hidden" name="confirmationToken" value="${escapeHtml(confirmationToken)}">
    <button class="btn btn-primary" type="submit">이 Rauhwpx에 연결</button>
  </form>
</section>`,
  });
}

export function renderReadyPage({
  pairingCode,
  manualCode,
  redirectUri = null,
  callbackState = null,
  authorizationCode,
}) {
  let callbackImage = '';
  if (redirectUri) {
    const callback = new URL(redirectUri);
    callback.searchParams.set('code', authorizationCode);
    callback.searchParams.set('state', callbackState);
    callbackImage = `<img src="${escapeHtml(callback.toString())}" alt="" width="1" height="1" hidden>`;
  }
  return shell({
    title: 'Rauhwpx',
    body: `
${callbackImage}
<section class="card">
  <div class="hero"><span></span></div>
  <h1>연결을 마무리하세요</h1>
  <p>같은 기기의 Rauhwpx에는 자동으로 전달됩니다. 다른 기기라면 아래 코드를 연결을 시작한 Rauhwpx에 입력하세요.</p>
  <div class="pairing">${escapeHtml(pairingCode)}</div>
  <div class="return-code">${escapeHtml(manualCode)}</div>
  <p class="notice">이 코드는 2분 동안 한 번만 쓸 수 있습니다. 누구에게도 보내지 마세요.</p>
</section>`,
  });
}

export function renderUniqueInstallsPage({ uniqueInstalls }) {
  const count = Number.isSafeInteger(uniqueInstalls) && uniqueInstalls >= 0 ? uniqueInstalls : 0;
  return shell({
    title: 'Rauhwpx 고유 설치',
    body: `
<section class="card">
  <div class="hero"><span></span></div>
  <h1>고유 데스크톱 설치</h1>
  <p class="hero-count">${escapeHtml(count.toLocaleString('ko-KR'))}</p>
  <p>공식 macOS arm64·Windows x64 앱을 설치한 뒤 그 기기에서 처음 연 횟수입니다. 자동 업데이트와 GitHub 다운로드 수는 넣지 않습니다.</p>
  <p>데스크톱 앱이 보낸 첫 실행 보고이며 기기 증명(attestation)은 아닙니다. HMAC은 아무 서명 없는 요청을 거를 뿐, 패키지를 연 누구나 같은 서명을 만들 수 있습니다.</p>
  <p>첫 실행 때 익명 설치 식별자, 앱 버전, OS, 아키텍처만 받습니다. 이름, 이메일, 호스트 이름, 문서 경로는 저장하지 않으며 IP는 신원으로 쓰지 않습니다.</p>
</section>`,
  });
}

export function renderFailPage({ message, device = '' }) {
  const retry = device
    ? `<a class="btn btn-primary" href="/login?device=${encodeURIComponent(device)}" style="margin-top:26px">다시 시도</a>`
    : '';
  return shell({
    title: 'Rauhwpx',
    body: `
<section class="card">
  <div class="hero"><span></span></div>
  <h1>연결하지 못했어요</h1>
  <p>${escapeHtml(message)}</p>
  <div class="stack">${retry}</div>
</section>`,
  });
}
