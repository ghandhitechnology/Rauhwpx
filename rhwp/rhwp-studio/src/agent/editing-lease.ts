import type { AgentEditingLease, AgentName } from './types.ts';

export interface AgentEditingActivity {
  turnRunning: boolean;
  activeToolRequests: number;
  agent: AgentName;
  waitingForUser?: boolean;
}

export function deriveAgentEditingLease(activity: AgentEditingActivity): AgentEditingLease {
  return {
    active: activity.turnRunning || activity.activeToolRequests > 0,
    agent: activity.agent,
    ...(activity.waitingForUser === true ? { waitingForUser: true } : {}),
  };
}
