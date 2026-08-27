---
name: present-plan
description: Present a completed implementation plan as the structured review artifact the user can open from chat. Use only after the user explicitly asked you to write, draft, or present a plan.
icon: system
---

Finish a requested plan through the structured plan review flow.

1. Use this skill only when the user asked you to write, draft, or present a plan. Otherwise stay in conversation and research.
2. Make the proposal concrete before presenting it: capture the goal, decisions, ordered steps, affected files, validation, risks, assumptions, and exclusions.
3. Call `present_implementation_plan` exactly once with the complete plan as the final action of the turn.
4. Do not tell the user the plan is ready, finished, or submitted until that tool returns success. Studio — not prose — creates the chat action that opens the plan review sidebar.
5. Do not call another tool afterward in the same turn.
6. If the user requests changes, treat that as renewed discovery: re-inspect affected current state. When feedback is ambiguous or changes an assumption, discuss it and ask a focused question in normal chat instead of immediately presenting a replacement. When they again ask for a draft and the feedback is already concrete, present a complete replacement through the same tool.
