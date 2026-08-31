import spawn from 'cross-spawn';

import {
  isolatedProcessEnv,
  PROCESS_TREE_CLEANUP_OUTCOME,
  processTreeSpawnOptions,
  terminateAndWaitForProcessTreeExitOutcome,
  terminateProcessTree,
} from '../process-tree.mjs';

/** 제목 자체는 짧지만 추론 모델은 생각에도 토큰을 쓴다 — 잘리지 않을 만큼만 준다. */
const TITLE_MAX_TOKENS = 256;
const TITLE_STDOUT_LIMIT_BYTES = 64 * 1024;
const TITLE_STDERR_LIMIT_BYTES = 16 * 1024;

/** OpenRouter 폴백을 실제로 탈 수 있는지 — 어떤 경우에 태울지는 서버가 정한다. */
export function openRouterReady({ useOpenRouter, piManager, openRouter } = {}) {
  return Boolean(useOpenRouter && openRouter && piManager?.apiKey?.());
}

/**
 * 짧은 채팅 제목을 만든다 (문서 MCP 세션과 분리).
 * 기본은 gpt-5.6-luna CLI, pi 사용자는 OpenRouter 의 가장 싼 모델을 쓴다.
 *
 * @param {string} preview
 * @param {{ useOpenRouter?: boolean, piManager?: any, openRouter?: any, isolatedHome?: string,
 *   sessionId?: string, cwd?: string, spawnProcess?: typeof spawn,
 *   terminateProcess?: typeof terminateProcessTree,
 *   cleanupProcessOutcome?: (child: any) => Promise<'proven'|'failed'|'unavailable'> }} [deps]
 * @returns {Promise<string | null>}
 */
export function generateChatTitle(preview, deps = {}) {
  const text = String(preview ?? '').trim().slice(0, 800);
  if (!text) return Promise.resolve(null);

  const prompt = [
    '다음 대화의 짧은 한국어 제목을 작성하세요.',
    '규칙: 최대 6단어, 설명/따옴표/번호 없이 제목 텍스트만 출력.',
    '',
    text,
  ].join('\n');

  if (openRouterReady(deps)) return titleViaOpenRouter(prompt, deps);

  return new Promise((resolve) => {
    const spawnProcess = deps.spawnProcess ?? spawn;
    const terminateProcess = deps.terminateProcess ?? terminateProcessTree;
    let settled = false;
    let buf = '';
    let lastAssistant = '';
    let stdoutBytes = 0;
    let stderr = '';
    let timer = null;
    let cleanupPromise = null;

    const finish = (value) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(value);
    };
    const finishAfterCleanup = (value, { allowUnavailable = false } = {}) => {
      if (timer) clearTimeout(timer);
      if (!cleanupPromise) {
        cleanupPromise = (typeof deps.cleanupProcessOutcome === 'function'
          ? Promise.resolve(deps.cleanupProcessOutcome(proc))
          : terminateAndWaitForProcessTreeExitOutcome(proc, { terminateProcess }))
          .catch(() => PROCESS_TREE_CLEANUP_OUTCOME.FAILED);
      }
      void cleanupPromise.then((outcome) => finish(
        outcome === PROCESS_TREE_CLEANUP_OUTCOME.PROVEN
          || (allowUnavailable && outcome === PROCESS_TREE_CLEANUP_OUTCOME.UNAVAILABLE)
          ? value
          : null,
      ));
    };

    let proc;
    try {
      proc = spawnProcess(
        'codex',
        [
          'exec',
          '--json',
          '--ephemeral',
          '--skip-git-repo-check',
          '--ignore-user-config',
          '--ignore-rules',
          '--disable', 'apps', '--disable', 'browser_use', '--disable', 'computer_use',
          '--disable', 'image_generation', '--disable', 'multi_agent', '--disable', 'plugins',
          '--disable', 'skill_search',
          '--sandbox', 'read-only',
          '-m', 'gpt-5.6-luna',
          '-c', 'model_reasoning_effort="low"',
          '-',
        ],
        {
          ...processTreeSpawnOptions(),
          ...(deps.cwd ? { cwd: deps.cwd } : {}),
          env: isolatedProcessEnv(deps),
          stdio: ['pipe', 'pipe', 'pipe'],
        },
      );
    } catch {
      finish(null);
      return;
    }

    timer = setTimeout(() => {
      finishAfterCleanup(cleanTitle(lastAssistant) || null);
    }, 45_000);

    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', (chunk) => {
      stdoutBytes += Buffer.byteLength(chunk, 'utf8');
      if (stdoutBytes > TITLE_STDOUT_LIMIT_BYTES) {
        finishAfterCleanup(cleanTitle(lastAssistant) || null);
        return;
      }
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let evt;
        try { evt = JSON.parse(line); } catch { continue; }
        const type = evt?.type;
        if (type === 'item.completed' && evt.item?.type === 'agent_message') {
          const t = String(evt.item.text ?? '').trim();
          if (t) {
            lastAssistant = t;
            // The hub owns this cleanup promise. Start it at the semantic
            // terminal event while a Windows PID still belongs to this child.
            if (typeof deps.cleanupProcessOutcome === 'function') {
              finishAfterCleanup(cleanTitle(lastAssistant) || null);
            }
          }
        } else if (type === 'agent.message' || type === 'message') {
          const t = String(evt.text ?? evt.message ?? '').trim();
          if (t) lastAssistant = t;
        }
      }
    });
    proc.stderr?.on?.('data', (chunk) => {
      stderr = (stderr + String(chunk)).slice(-TITLE_STDERR_LIMIT_BYTES);
    });

    proc.on('error', () => {
      if (proc.pid) finishAfterCleanup(null);
      else finish(null);
    });
    proc.on('close', (code) => {
      const title = code === 0 ? (cleanTitle(lastAssistant) || null) : null;
      // `close` is the drained boundary. Preserve a completed title when an
      // already-exited Windows PID makes tree proof unavailable; forced paths
      // above still require PROVEN cleanup.
      finishAfterCleanup(title, { allowUnavailable: code === 0 && title !== null });
    });
    proc.stdin?.on?.('error', () => {
      finishAfterCleanup(null);
    });

    try {
      proc.stdin.end(prompt);
    } catch {
      finishAfterCleanup(null);
    }
  });
}

/** 실패하면 제목 없이 넘어간다 — 제목은 있으면 좋은 정도의 정보다. */
async function titleViaOpenRouter(prompt, { piManager, openRouter }) {
  try {
    const model = piManager.cheapestModel();
    if (!model) return null;
    const text = await openRouter.chat({
      key: piManager.apiKey(),
      model: model.id,
      messages: [{ role: 'user', content: prompt }],
      maxTokens: TITLE_MAX_TOKENS,
      temperature: 0.2,
      timeout: 30_000,
    });
    return cleanTitle(text) || null;
  } catch {
    return null;
  }
}

function cleanTitle(raw) {
  if (!raw) return null;
  const line = String(raw)
    .split('\n')
    .map((s) => s.trim())
    .find((s) => s.length > 0);
  if (!line) return null;
  return line
    .replace(/^["'`「『]+|["'`」』]+$/g, '')
    .replace(/^(제목|Title)\s*[:：]\s*/i, '')
    .trim()
    .slice(0, 48) || null;
}
