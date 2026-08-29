---
name: present-plan
description: Present a completed implementation plan as the structured review artifact the user can open from chat. Use only after the user explicitly asked you to write, draft, or present a plan.
icon: system
---

Finish a requested plan through the structured plan review flow.

1. Use this skill only when the user asked you to write, draft, or present a plan.
2. Capture the goal, decisions, ordered steps, files, validation, risks, assumptions, and exclusions.
3. Call `present_implementation_plan` exactly once as the final action of the turn.
4. Do not tell the user the plan is ready until that tool returns success.
5. Do not call another tool afterward.
6. If the user requests changes, treat that as renewed discovery and re-inspect. Present a replacement only when they ask again and the feedback is concrete.
