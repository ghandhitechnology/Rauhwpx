---
name: rewrite-tone
description: Rewrite selected Korean HWP/HWPX text into a requested tone such as formal, concise, persuasive, friendly, or executive while preserving its facts. Use when the user asks to 말투 변경, 문체 변환, 더 공손하게, 더 간결하게, or tone polishing.
icon: pencil
---

Read the exact source range and identify the requested audience and tone.

1. Preserve facts, names, dates, numbers, obligations, and logical qualifications.
2. Change only wording and sentence structure needed for the requested tone.
3. Send the rewrites as ONE `apply_edits` batch of `replace_range` items addressed by `anchor`, preserving surrounding formatting.
4. Avoid adding claims, urgency, praise, or certainty that the source does not support.
5. Check the batch's `after` text, fix any warnings, and briefly describe the tone shift.
