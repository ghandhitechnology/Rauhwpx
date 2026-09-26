---
name: proofread-korean
description: Proofread Korean HWP/HWPX writing for spelling, spacing, grammar, punctuation, and natural office tone while preserving facts and formatting. Use when the user asks to 교정, 교열, 맞춤법 검사, or polish Korean prose.
icon: pencil
---

Read the relevant selection or document range once; put several ranges in one `read_batch`.

1. Preserve names, figures, dates, legal meaning, and the author's intended level of formality.
2. Correct only defensible spelling, spacing, grammar, punctuation, and awkward phrasing.
3. Send every correction as ONE `apply_edits` batch of `replace_range` items, each addressed by `anchor` on the wrong text (`occurrence` or `within` when it repeats). Do not rebuild unaffected paragraphs.
4. Preserve character and paragraph formatting unless the user asks for formatting changes.
5. Check the batch's `after` text, fix any warnings, and summarize material wording changes.
