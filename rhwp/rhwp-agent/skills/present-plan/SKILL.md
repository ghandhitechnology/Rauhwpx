---
name: present-plan
description: Present a completed implementation plan as the structured review artifact the user can open from chat. Use at the end of planning, once the proposal is concrete and ready for approval.
icon: system
---

Finish planning through the structured plan review flow.

1. Make the proposal concrete before presenting it: capture the goal, decisions, ordered steps, affected files, validation, risks, assumptions, and exclusions.
2. Call `present_implementation_plan` exactly once with the complete plan.
3. Treat that call as the final planning artifact. Do not call another tool afterward in the same turn.
4. Do not rely on a prose-only plan in the assistant response. The structured call creates the chat action that opens the plan review sidebar.
5. If the user requests changes, treat that as renewed discovery: re-inspect affected current state. When feedback is ambiguous or changes an assumption, discuss it and ask a focused question in normal chat instead of immediately presenting a replacement. When feedback is already concrete, follow the planning checkpoint rules and present a complete replacement through the same tool.
