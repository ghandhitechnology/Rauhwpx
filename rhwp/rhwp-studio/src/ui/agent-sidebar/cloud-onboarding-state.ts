import type { CloudProfileDraft, CloudSnapshot } from '../../cloud/types.ts';

export type CloudSetupIntent = 'transfer' | 'manage';
export type CloudSetupStage = 'installing';
export type CloudProfileField =
  | 'name'
  | 'host'
  | 'sshUser'
  | 'sshPort'
  | 'tailscaleHttpsPort'
  | 'endpoint'
  | 'keyPath'
  | 'serverPublicKey'
  | 'pairingCode';
export type CloudFieldErrors = Partial<Record<CloudProfileField, string>>;

export interface CloudSetupIssue {
  title: string;
  guidance: string;
  detail: string;
}

export type CloudSetupState =
  | { kind: 'intro'; draft: CloudProfileDraft; intent: CloudSetupIntent }
  | { kind: 'editing'; draft: CloudProfileDraft; intent: CloudSetupIntent; errors: CloudFieldErrors }
  | { kind: 'checking'; draft: CloudProfileDraft; intent: CloudSetupIntent }
  | { kind: 'check-failed'; draft: CloudProfileDraft; intent: CloudSetupIntent; issue: CloudSetupIssue }
  | { kind: 'ready-to-install'; draft: CloudProfileDraft; intent: CloudSetupIntent }
  | { kind: 'installing'; draft: CloudProfileDraft; intent: CloudSetupIntent; stage: CloudSetupStage }
  | {
      kind: 'install-failed';
      draft: CloudProfileDraft;
      intent: CloudSetupIntent;
      issue: CloudSetupIssue;
      retry: 'install' | 'pair';
      pairingCode?: string;
    }
  | {
      kind: 'existing';
      draft: CloudProfileDraft;
      intent: CloudSetupIntent;
      errors: CloudFieldErrors;
      pairingCode: string;
    }
  | { kind: 'pairing'; draft: CloudProfileDraft; intent: CloudSetupIntent; pairingCode: string }
  | { kind: 'connected'; profile: CloudProfileDraft; intent: CloudSetupIntent };

const DEFAULT_DRAFT: CloudProfileDraft = {
  name: 'My VPS',
  host: '',
  sshUser: 'ubuntu',
  sshPort: 22,
  tailscaleHttpsPort: 443,
  auth: { kind: 'ssh-agent' },
  transport: { kind: 'tailscale' },
};

function cloneDraft(draft: CloudProfileDraft): CloudProfileDraft {
  const { serverPublicKey, ...rest } = draft;
  return {
    ...rest,
    name: draft.name.trim(),
    host: draft.host.trim(),
    sshUser: draft.sshUser.trim(),
    ...(typeof serverPublicKey === 'string' ? { serverPublicKey: serverPublicKey.trim() } : {}),
    auth: draft.auth.kind === 'key-file'
      ? { kind: 'key-file', keyPath: draft.auth.keyPath.trim() }
      : { kind: 'ssh-agent' },
    transport: draft.transport.kind === 'https'
      ? { kind: 'https', endpoint: draft.transport.endpoint.trim() }
      : { kind: 'tailscale' },
  };
}

function draftsEqual(left: CloudProfileDraft, right: CloudProfileDraft): boolean {
  return left.name === right.name
    && left.host === right.host
    && left.sshUser === right.sshUser
    && left.sshPort === right.sshPort
    && left.tailscaleHttpsPort === right.tailscaleHttpsPort
    && left.serverPublicKey === right.serverPublicKey
    && left.auth.kind === right.auth.kind
    && (left.auth.kind !== 'key-file' || (right.auth.kind === 'key-file' && left.auth.keyPath === right.auth.keyPath))
    && left.transport.kind === right.transport.kind
    && (left.transport.kind !== 'https' || (right.transport.kind === 'https' && left.transport.endpoint === right.transport.endpoint));
}

function validHost(host: string): boolean {
  if (host.length < 1 || host.length > 253) return false;
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host)) {
    return host.split('.').every((part) => /^(?:0|[1-9]\d{0,2})$/.test(part) && Number(part) <= 255);
  }
  return /^(?!-)[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$/.test(host);
}

function isTailscaleHost(host: string): boolean {
  const value = host.toLowerCase();
  if (value.endsWith('.ts.net') || !value.includes('.')) return validHost(value);
  const parts = value.split('.').map(Number);
  return parts.length === 4 && parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127
    && parts.every((part) => Number.isInteger(part) && part >= 0 && part <= 255);
}

function validHttpsEndpoint(endpoint: string): boolean {
  try {
    const url = new URL(endpoint);
    return url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash;
  } catch {
    return false;
  }
}

export function defaultCloudProfileDraft(profile?: CloudProfileDraft): CloudProfileDraft {
  return cloneDraft(profile ?? DEFAULT_DRAFT);
}

export function validateCloudProfileDraft(
  draft: CloudProfileDraft,
  options: { existing?: boolean; pairingCode?: string } = {},
): CloudFieldErrors {
  const errors: CloudFieldErrors = {};
  const host = draft.host.trim();
  if (!host) errors.host = 'VPS의 Tailscale IP 또는 기기 이름을 입력하세요.';
  else if (!validHost(host)) errors.host = '프로토콜이나 경로 없이 올바른 VPS 주소를 입력하세요.';
  else if (draft.transport.kind === 'tailscale' && !isTailscaleHost(host)) errors.host = 'Tailscale IP 또는 MagicDNS 기기 이름을 입력하세요.';
  if (!draft.sshUser.trim()) errors.sshUser = 'SSH 사용자 이름을 입력하세요.';
  else if (!/^[A-Za-z_][A-Za-z0-9_-]{0,31}$/.test(draft.sshUser.trim())) errors.sshUser = '올바른 SSH 사용자 이름을 입력하세요.';
  if (!draft.name.trim()) errors.name = '이 VPS를 구분할 이름을 입력하세요.';
  else if (draft.name.trim().length > 80) errors.name = '환경 이름은 80자 이하로 입력하세요.';
  if (!Number.isSafeInteger(draft.sshPort) || draft.sshPort < 1 || draft.sshPort > 65535) errors.sshPort = '1부터 65535 사이의 포트를 입력하세요.';
  const httpsPort = draft.tailscaleHttpsPort ?? 443;
  if (!Number.isSafeInteger(httpsPort) || httpsPort < 1 || httpsPort > 65535) errors.tailscaleHttpsPort = '1부터 65535 사이의 포트를 입력하세요.';
  if (draft.auth.kind === 'key-file' && !draft.auth.keyPath.trim()) errors.keyPath = '개인 키 파일 경로를 입력하세요.';
  else if (draft.auth.kind === 'key-file' && (draft.auth.keyPath.includes('\0') || draft.auth.keyPath.trim().length > 4096)) {
    errors.keyPath = '올바른 개인 키 파일 경로를 입력하세요.';
  }
  if (draft.transport.kind === 'https' && !validHttpsEndpoint(draft.transport.endpoint.trim())) {
    errors.endpoint = '자격 증명, 쿼리, 조각이 없는 HTTPS 주소를 입력하세요.';
  }
  if (options.existing) {
    if (!draft.serverPublicKey?.trim()) errors.serverPublicKey = '서버에서 표시한 ID 키를 입력하세요.';
    else if (!/^ed25519:[A-Za-z0-9_-]{59}$/.test(draft.serverPublicKey.trim())) errors.serverPublicKey = 'ed25519:로 시작하는 서버 ID 키를 확인하세요.';
    const code = options.pairingCode?.trim().toUpperCase() ?? '';
    if (!/^[A-Z2-9]{4}(?:-[A-Z2-9]{4}){2}$/.test(code)) errors.pairingCode = 'XXXX-XXXX-XXXX 형식의 페어링 코드를 입력하세요.';
  }
  return errors;
}

export function mapCloudSetupIssue(error: unknown, transport: CloudProfileDraft['transport']['kind'] = 'tailscale'): CloudSetupIssue {
  const detail = error instanceof Error ? error.message : String(error);
  const normalized = detail.toLowerCase();
  if (/permission denied|authentication failed|publickey/.test(normalized)) {
    return { title: 'SSH 인증에 실패했습니다', guidance: 'SSH agent에 키를 추가하거나 올바른 개인 키 파일을 선택하세요.', detail };
  }
  if (/timed out|timeout|econnrefused|could not resolve|name or service not known|no route to host/.test(normalized)) {
    return {
      title: 'VPS에 연결할 수 없습니다',
      guidance: transport === 'tailscale'
        ? '두 기기의 Tailscale 연결과 VPS 주소, SSH 포트를 확인하세요.'
        : 'VPS 주소, SSH 포트, 방화벽과 HTTPS 주소를 확인하세요.',
      detail,
    };
  }
  if (/passwordless sudo|sudo.*password|requires a password/.test(normalized)) {
    return { title: '비밀번호 없는 sudo가 필요합니다', guidance: 'SSH 사용자에게 비밀번호 없이 sudo를 실행할 권한을 설정한 뒤 다시 시도하세요.', detail };
  }
  if (/ubuntu|debian|unsupported.*distribution|operating system/.test(normalized)) {
    return { title: '지원하는 Linux가 필요합니다', guidance: 'Ubuntu 또는 Debian VPS를 사용하세요.', detail };
  }
  if (/no compatible (?:stable |prerelease )?cloud asset|cloud release asset|curl.*(?:requested url.*404|error:\s*404)/.test(normalized)) {
    return {
      title: 'Cloud 설치 파일을 찾을 수 없습니다',
      guidance: '현재 앱 버전과 맞는 Cloud 설치 파일이 아직 배포되지 않았습니다. 앱을 업데이트하거나 잠시 후 다시 시도하세요.',
      detail,
    };
  }
  if (transport === 'tailscale' && /enotfound|name_not_resolved|could not resolve|dns|fetch failed|failed to fetch/.test(normalized)) {
    return {
      title: 'Tailscale DNS를 켜 주세요',
      guidance: '이 기기의 Tailscale 설정에서 DNS 사용(Accept DNS)을 켠 뒤 다시 연결하세요.',
      detail,
    };
  }
  if (/tailscale/.test(normalized)) {
    return { title: 'VPS의 Tailscale을 확인하세요', guidance: 'VPS에 Tailscale을 설치하고 이 기기와 같은 네트워크에 연결하세요.', detail };
  }
  if (/architecture|amd64|arm64|x86_64|aarch64/.test(normalized)) {
    return { title: '지원하지 않는 서버 구조입니다', guidance: 'amd64 또는 arm64 VPS를 사용하세요.', detail };
  }
  if (/identity|server.*key|signature|pinned/.test(normalized)) {
    return { title: '서버 ID를 확인하지 못했습니다', guidance: '서버 ID 키가 바뀌지 않았는지 확인하세요. 예상하지 못한 변경이면 연결을 중단하세요.', detail };
  }
  if (/pairing|code.*expired|invalid code/.test(normalized)) {
    return { title: '페어링 코드를 사용할 수 없습니다', guidance: 'VPS에서 새 페어링 코드를 만든 뒤 다시 입력하세요.', detail };
  }
  return { title: 'Cloud 설정을 마치지 못했습니다', guidance: '연결 정보를 확인하고 다시 시도하세요.', detail };
}

export function snapshotProfile(snapshot: CloudSnapshot): CloudProfileDraft | undefined {
  return snapshot.profile.kind === 'configured' ? defaultCloudProfileDraft(snapshot.profile.profile) : undefined;
}

export function createCloudSetupState(snapshot: CloudSnapshot, intent: CloudSetupIntent): CloudSetupState {
  const profile = snapshotProfile(snapshot);
  if (profile && snapshot.profile.kind === 'configured' && snapshot.profile.connection === 'ready') {
    return { kind: 'connected', profile, intent };
  }
  return { kind: 'intro', draft: defaultCloudProfileDraft(profile), intent };
}

export function reconcileCloudSetupState(state: CloudSetupState, snapshot: CloudSnapshot): CloudSetupState {
  if (state.kind !== 'connected') return state;
  const profile = snapshotProfile(snapshot);
  return profile && snapshot.profile.kind === 'configured' && snapshot.profile.connection === 'ready'
    ? draftsEqual(profile, state.profile) ? state : { ...state, profile }
    : { kind: 'intro', draft: defaultCloudProfileDraft(profile ?? state.profile), intent: state.intent };
}
