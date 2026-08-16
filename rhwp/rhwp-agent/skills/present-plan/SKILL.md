---
name: present-plan
description: Present a completed implementation plan as the structured review artifact the user can open from chat. Use at the end of planning, once the proposal is concrete and ready for approval.
---

Finish planning through the structured plan review flow.

1. Make the proposal concrete before presenting it: capture the goal, decisions, ordered steps, affected files, validation, risks, assumptions, and exclusions.
2. Call `present_implementation_plan` exactly once with the complete plan.
3. Treat that call as the final planning artifact. Do not call another tool afterward in the same turn.
4. Do not rely on a prose-only plan in the assistant response. The structured call creates the chat action that opens the plan review sidebar.
5. If the user requests changes, revise the complete plan and present its replacement through the same tool.
