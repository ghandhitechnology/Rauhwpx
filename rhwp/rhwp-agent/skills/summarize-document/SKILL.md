---
name: summarize-document
description: Summarize an open HWP/HWPX document or selection into a faithful Korean brief, outline, executive summary, or key-point list. Use when the user asks for 요약, 핵심 정리, 개요, or an executive summary.
icon: bot
---

Read the document structure, then fetch the text ranges needed for a complete summary.

1. Distinguish source facts from inference and do not invent missing context.
2. Preserve important names, dates, amounts, decisions, obligations, and exceptions.
3. Match the requested length and format; ask only when the intended audience materially changes the result.
4. Return the summary in chat unless the user explicitly asks to insert it into the document.
5. When inserting, use real paragraphs and `apply_list` for lists, then call `verify_changes`.
