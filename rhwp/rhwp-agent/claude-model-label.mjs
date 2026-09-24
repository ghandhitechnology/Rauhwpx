// Claude 모델 표시 이름 — 허브 카탈로그와 스튜디오 캐시가 같은 규칙을 쓴다.
// 스튜디오 쪽 사본은 rhwp-studio/src/agent/models.ts 의 claudeModelLabel 이고,
// rhwp-studio/tests/agent-models.test.ts 가 두 구현의 결과를 비교한다.

/**
 * Anthropic 공식 최신 Claude 모델. 설치된 CLI가 옛 버전을 알려도 이 목록이 우선한다.
 * 스튜디오 사본은 rhwp-studio/src/agent/models.ts 의 OFFICIAL_CLAUDE_MODELS 이다.
 */
export const OFFICIAL_CLAUDE_MODELS = Object.freeze([
  'claude-fable-5-1',
  'claude-opus-5-5',
  'claude-sonnet-5',
  'claude-haiku-4-5-20251001',
]);

const FAMILY = /^claude-([a-z]+)((?:-\d+)+?)(?:-(\d{8}))?(\[[^\]]+\])?$/;

/** claude-opus-5-5[1m] → "Opus 5.5 (1M)", claude-haiku-4-5-20251001 → "Haiku 4.5". */
export function claudeModelLabel(id, fallback = id) {
  const match = FAMILY.exec(id);
  if (!match) return fallback;
  const [, family, version, , context] = match;
  const name = family.charAt(0).toUpperCase() + family.slice(1);
  const suffix = context ? ` (${context.slice(1, -1).toUpperCase()})` : '';
  return `${name} ${version.slice(1).split('-').join('.')}${suffix}`;
}

/** CLI 설명 앞의 "Sonnet 5 · " 같은 이름 반복을 걷어 한 줄 설명만 남긴다. */
export function claudeModelDescription(description) {
  if (typeof description !== 'string') return '';
  const trimmed = description.trim();
  const parts = trimmed.split(' · ');
  if (parts.length > 1 && /^(Fable|Opus|Sonnet|Haiku)\b/i.test(parts[0])) return parts.slice(1).join(' · ').trim();
  return trimmed;
}
