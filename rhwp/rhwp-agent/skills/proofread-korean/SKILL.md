---
name: proofread-korean
description: Proofread Korean HWP/HWPX writing for spelling, spacing, grammar, punctuation, and natural office tone while preserving facts and formatting. Use when the user asks to 교정, 교열, 맞춤법 검사, or polish Korean prose.
---

Read the relevant selection or document range before editing.

1. Preserve names, figures, dates, legal meaning, and the author's intended level of formality.
2. Correct only defensible spelling, spacing, grammar, punctuation, and awkward phrasing.
3. Use `replace_range` for each exact correction. Do not rebuild unaffected paragraphs. Send independent corrections as one `apply_edits` batch ordered from the end of the document backwards.
4. Preserve character and paragraph formatting unless the user asks for formatting changes.
5. Call `verify_changes` after the correction batch and summarize material wording changes.

