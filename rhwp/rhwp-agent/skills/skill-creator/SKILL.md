---
name: skill-creator
description: Create or improve a reusable rhwp product skill with clear triggers, concise instructions, and optional scripts, references, or assets. Use when the user asks to create, define, or update a skill in rhwp.
icon: bot
---

Create and refine rhwp product skills with the product skill tools. Do not write Claude, Codex, Cursor, or Pi global skill directories, and do not ask for a Studio form.

1. Call `list_harness_skills` when the user wants to bring in a skill that already exists in a harness.
2. Call `read_product_skill` before changing a skill that is already enabled.
3. Call `commit_product_skill` to create a skill, replace one file, replace the instruction body, import a harness skill, or delete a user skill. Send only the fields for that action.
4. Pass the digest from `read_product_skill` or the previous commit as `base` for `write`, `body`, `delete`, and `replace`. If the result is stale, read the skill again and retry once with the new digest.
5. Prefer a short `SKILL.md`. Add scripts or references only when they make the skill reliable.
6. Keep `name` and `description` in frontmatter. `icon` may be `pencil`, `bot`, or `system`.
