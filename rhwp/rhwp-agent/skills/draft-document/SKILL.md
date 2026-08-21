---
name: draft-document
description: Draft structured Korean office-document content in the open HWP/HWPX file. Use for 보고서, 공문, 기안, 안내문, 회의록, 계획서, and other requests to write a new document or substantial section.
icon: pencil
---

Establish the document purpose, audience, required facts, tone, and approximate length from the request and existing document.

1. Do not fabricate factual claims, approvals, dates, people, amounts, or institutional policy.
2. Build a clear heading hierarchy and concise Korean office prose.
3. Use actual paragraphs and `apply_list`; never type fake list markers.
4. Reuse existing styles and formatting when available.
5. Insert the draft as pending edits and call `verify_changes` with an image when layout matters. Send independent insertions as one `apply_edits` batch ordered from the end of the document backwards.
