import path from 'node:path';

export const COPY_LAYOUT_HELPER_BASENAME = 'copy_layout.py';

/**
 * grok 스코프 셸 접두사. 인터프리터 이름만 열면 `python3 -c` 와 임의 스크립트가
 * 통과하므로, 잡에 복사된 copy_layout.py 절대 경로까지 고정한다.
 *
 * @param {string} helperPath
 * @returns {string[]}
 */
export function copyLayoutShellAllowPrefixes(helperPath) {
  const helper = path.resolve(String(helperPath ?? ''));
  if (path.basename(helper) !== COPY_LAYOUT_HELPER_BASENAME) {
    throw new Error('copy-layout shell allowlist requires the job copy_layout.py path');
  }
  /** @type {string[]} */
  const prefixes = [];
  for (const interpreter of ['python3', 'python']) {
    prefixes.push(`${interpreter} ${helper}`);
    prefixes.push(`${interpreter} "${helper}"`);
  }
  return prefixes;
}

/**
 * grok 의 `Bash(prefix)` / `Bash(prefix *)` 규칙과 같은 경계인지 본다.
 * 접두사 정확 일치 또는 접두사 + 공백 + 인자만 통과한다.
 *
 * @param {string} command
 * @param {string} helperPath
 */
export function copyLayoutShellCommandAllowed(command, helperPath) {
  const text = String(command ?? '').trim();
  if (!text) return false;
  return copyLayoutShellAllowPrefixes(helperPath).some(
    (prefix) => text === prefix || text.startsWith(`${prefix} `),
  );
}
