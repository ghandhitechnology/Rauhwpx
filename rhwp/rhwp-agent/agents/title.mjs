import { spawn } from 'node:child_process';

/** 제목 자체는 짧지만 추론 모델은 생각에도 토큰을 쓴다 — 잘리지 않을 만큼만 준다. */
const TITLE_MAX_TOKENS = 256;

/** OpenRouter 폴백을 실제로 탈 수 있는지 — 어떤 경우에 태울지는 서버가 정한다. */
export function openRouterReady({ useOpenRouter, piManager, openRouter } = {}) {
  return Boolean(useOpenRouter && openRouter && piManager?.apiKey?.());
}

/**
 * 짧은 채팅 제목을 만든다 (문서 MCP 세션과 분리).
 * 기본은 gpt-5.6-luna CLI, pi 사용자는 OpenRouter 의 가장 싼 모델을 쓴다.
 *
 * @param {string} preview
 * @param {{ useOpenRouter?: boolean, piManager?: any, openRouter?: any }} [deps]
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
    let settled = false;
    let buf = '';
    let lastAssistant = '';

    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    let proc;
    try {
      proc = spawn(
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
        { env: process.env, stdio: ['pipe', 'pipe', 'pipe'] },
      );
    } catch {
      finish(null);
      return;
    }

    const timer = setTimeout(() => {
      try { proc.kill('SIGTERM'); } catch {}
      // SIGTERM 을 무시하는 자식이 남지 않도록 강제 종료로 승격한다.
      const killTimer = setTimeout(() => { try { proc.kill('SIGKILL'); } catch {} }, 3_000);
      if (killTimer.unref) killTimer.unref();
      finish(cleanTitle(lastAssistant) || null);
    }, 45_000);
    if (timer.unref) timer.unref();

    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', (chunk) => {
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
          if (t) lastAssistant = t;
        } else if (type === 'agent.message' || type === 'message') {
          const t = String(evt.text ?? evt.message ?? '').trim();
          if (t) lastAssistant = t;
        }
      }
    });

    proc.on('error', () => {
      clearTimeout(timer);
      finish(null);
    });
    proc.on('close', () => {
      clearTimeout(timer);
      finish(cleanTitle(lastAssistant) || null);
    });

    try {
      proc.stdin.end(prompt);
    } catch {
      clearTimeout(timer);
      finish(null);
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
