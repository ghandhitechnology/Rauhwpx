---
name: present-plan
description: Present a document editing plan for review, or revise an existing plan from concrete user feedback.
icon: system
---

Finish a requested plan through the structured plan review flow.

1. Use this skill when the user asks for a plan or gives concrete changes to an existing plan. Continue ordinary discussion and research without replacing the plan when no changes were requested.
2. Read the current live document with get_structure before presenting. Capture the goal, decisions, ordered steps, document targets, proposed text or visible results, validation, risks, assumptions, and exclusions. Include actual sources as title plus URL or reference file/chunk IDs; never invent citations. Keep files only for relevant file work. Add a concise changeSummary for a revised version.
3. Call `present_implementation_plan` exactly once as the final action of the turn.
4. Do not tell the user the plan is ready until that tool returns success.
5. Do not call another tool afterward.
6. If the user requests concrete changes, inspect the affected state and present the replacement directly. Ask a question only when missing information blocks the revision. Applying any version still requires explicit approval.
