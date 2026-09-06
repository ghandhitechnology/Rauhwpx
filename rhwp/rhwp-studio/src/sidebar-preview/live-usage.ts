import type { CodexResetResult, UsageSummary } from '../agent/types.ts';

async function request(frame: Record<string, unknown>) {
  const response = await fetch('/__sidebar-live-usage', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Sidebar-Audit': '1' },
    body: JSON.stringify(frame), signal: AbortSignal.timeout(85000),
  });
  if (!response.ok) throw new Error('실제 사용량 허브에 연결하지 못했어요.');
  const result = await response.json();
  if (result.type === 'usage-error' || result.type === 'codex-reset-error') {
    throw new Error(result.message || '실제 사용량을 확인하지 못했어요.');
  }
  if (!result.usage?.providers || !result.usage?.limits) throw new Error('실제 사용량 응답이 없어요.');
  return result;
}

export async function requestLiveUsage(refresh = false): Promise<UsageSummary> {
  return (await request({ type: 'usage-request', refresh })).usage;
}

export async function consumeLiveCodexReset(idempotencyKey: string, accountKey: string): Promise<CodexResetResult> {
  const result = await request({ type: 'codex-reset-consume', idempotencyKey, accountKey });
  return { outcome: result.outcome, usage: result.usage };
}
