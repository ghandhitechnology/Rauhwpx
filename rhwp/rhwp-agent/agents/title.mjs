import { spawn } from 'node:child_process';

/**
 * gpt-5.6-luna 로 짧은 채팅 제목을 만든다 (문서 MCP 세션과 분리).
 * @param {string} preview
 * @returns {Promise<string | null>}
 */
export function generateChatTitle(preview) {
  const text = String(preview ?? '').trim().slice(0, 800);
  if (!text) return Promise.resolve(null);

  const prompt = [
    '다음 대화의 짧은 한국어 제목을 작성하세요.',
    '규칙: 최대 6단어, 설명/따옴표/번호 없이 제목 텍스트만 출력.',
    '',
    text,
  ].join('\n');

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
