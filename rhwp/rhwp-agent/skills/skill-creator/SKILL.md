---
name: skill-creator
description: Create or improve a reusable rhwp product skill with clear triggers, concise instructions, and optional scripts, references, or assets. Use when the user asks to create, define, or update a skill in rhwp.
icon: bot
---

Use rhwp's guided skill creator rather than writing into Claude or Codex global skill directories.

1. Clarify the reusable goal with trigger and non-trigger examples.
2. Prefer instruction-only skills unless deterministic scripts or durable references materially improve reliability.
3. Keep `SKILL.md` concise with `name`, `description`, and the optional UI-selected `icon` in frontmatter.
4. Review every generated file and warn before saving executable scripts.
5. Save only after the user confirms the draft in the skill library.
