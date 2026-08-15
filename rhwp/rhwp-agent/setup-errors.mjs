const CERT_RE = /SELF_SIGNED_CERT|CERT_|UNABLE_TO_VERIFY|unable to get local issuer|certificate/i;
const NETWORK_RE = /ECONNRESET|ETIMEDOUT|ENETUNREACH|EAI_AGAIN|proxy|socket hang up|network/i;
const INTERACTIVE_RE = /TTY|interactive terminal|not a terminal|raw mode/i;

export function setupFailureMessage(error, detail, fallback) {
  const text = `${error?.code ?? ''} ${error?.message ?? ''} ${detail ?? ''}`;
  if (/EPERM|EBUSY|ENOTEMPTY|access is denied|being used by another process/i.test(text)) {
    return '설치 파일이 다른 프로세스에 의해 사용 중이에요. 실행 중인 harness를 종료하고 Windows Defender 검사가 끝난 뒤 다시 시도하세요.';
  }
  if (/ENAMETOOLONG|path too long|filename or extension is too long/i.test(text)) {
    return 'Windows 경로가 너무 길어요. RHWP_CLI_DIR 또는 RHWP_PI_DIR을 C:\\rhwp처럼 짧은 경로로 설정해 주세요.';
  }
  if (CERT_RE.test(text)) {
    return '회사 인증서를 확인하지 못했어요. NODE_EXTRA_CA_CERTS 또는 npm cafile에 회사 CA 인증서를 설정해 주세요.';
  }
  if (NETWORK_RE.test(text)) {
    return 'npm 레지스트리에 연결하지 못했어요. HTTPS_PROXY, HTTP_PROXY와 회사 방화벽 설정을 확인해 주세요.';
  }
  if (INTERACTIVE_RE.test(text)) {
    return '이 로그인 방식은 대화형 터미널을 요구해요. 브라우저 OAuth 또는 API 키 로그인을 사용해 주세요.';
  }
  return detail ? `${fallback}: ${detail}` : fallback;
}

export function shouldUseNpmNetworkPath(env = process.env) {
  return Boolean(env.HTTPS_PROXY || env.HTTP_PROXY || env.ALL_PROXY
    || env.https_proxy || env.http_proxy || env.all_proxy
    || env.NODE_EXTRA_CA_CERTS || env.npm_config_cafile);
}
