import type { AgentEditingLease, AgentName, AgentPhase, AgentWorkflow } from './types.ts';

export interface AgentEditingActivity {
  turnRunning: boolean;
  activeToolRequests: number;
  agent: AgentName;
  workflow?: AgentWorkflow;
  phase?: AgentPhase;
  waitingForUser?: boolean;
}

/**
 * 바로 실행과 승인 후 구현은 사용자 편집을 잠그고, 구상·질문·승인 대기 중에는
 * 사용자가 문서를 계속 고칠 수 있다. switching 은 실행 전환 창이라 잠근다.
 */
export function planModeAllowsUserEditing(
  workflow: AgentWorkflow | undefined,
  phase: AgentPhase | undefined,
): boolean {
  return workflow === 'question'
    || (workflow === 'plan' && (phase === 'planning' || phase === 'awaiting-approval'));
}

export function deriveAgentEditingLease(activity: AgentEditingActivity): AgentEditingLease {
  const busy = activity.turnRunning || activity.activeToolRequests > 0;
  const switching = activity.workflow === 'plan' && activity.phase === 'switching';
  return {
    active: switching || (busy && !planModeAllowsUserEditing(activity.workflow, activity.phase)),
    agent: activity.agent,
    ...(activity.waitingForUser === true ? { waitingForUser: true } : {}),
  };
}


/** A worker shares one live document; the busy lease still guards replacement. */
export function agentLeaseBlocksUserEditing(lease: AgentEditingLease, concurrentWorkerEditing = false): boolean {
  return lease.active && !concurrentWorkerEditing;
}
