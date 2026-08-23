import type { AgentEditingLease, AgentName } from './types.ts';

export interface AgentEditingActivity {
  turnRunning: boolean;
  activeToolRequests: number;
  agent: AgentName;
}

export function deriveAgentEditingLease(activity: AgentEditingActivity): AgentEditingLease {
  return {
    active: activity.turnRunning || activity.activeToolRequests > 0,
    agent: activity.agent,
  };
}
