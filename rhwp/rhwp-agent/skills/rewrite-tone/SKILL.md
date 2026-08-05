---
name: rewrite-tone
description: Rewrite selected Korean HWP/HWPX text into a requested tone such as formal, concise, persuasive, friendly, or executive while preserving its facts. Use when the user asks to 말투 변경, 문체 변환, 더 공손하게, 더 간결하게, or tone polishing.
---

Read the exact source range and identify the requested audience and tone.

1. Preserve facts, names, dates, numbers, obligations, and logical qualifications.
2. Change only wording and sentence structure needed for the requested tone.
3. Use `replace_range` rather than delete plus insert, and preserve surrounding formatting.
4. Avoid adding claims, urgency, praise, or certainty that the source does not support.
5. Call `verify_changes` and briefly describe the tone shift.

