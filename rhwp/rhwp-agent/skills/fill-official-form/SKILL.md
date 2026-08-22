---
name: fill-official-form
description: Fill the open Rauhwpx 공문 or 품의 form on the live editor page. Use when the user asks to 채우다, 기안하다, or complete 공문/품의/온메일 fields in the already-open document.
icon: pencil
---

Fill the **open** 공문/품의 document only when it is this Rauhwpx pack (`rauhwpx-office` in `META-INF/rauhwpx-form-pack`). A user file named `공문.hwpx` or `품의.hwpx` is a normal document unless it has that id. This pack is not 온나라-certified.

Do not copy it to a sidecar file, do not extract-replace on disk, and do not replace the whole document.

1. Call `get_document_info` and `get_fields`. Use the returned `revision` on every write.
2. Match user-supplied facts to existing field names (`행정기관명`, `수신자`, `제목`, `본문`, `결재직위1` …). Do not invent approvals, dates, people, or amounts.
3. Write with `set_field_value` or one `apply_edits` batch of `set_field_value` items. Coordinates stay on the live page; nested 결재란 tables must remain in place.
4. After filling, `get_fields` again to confirm values. If layout looks wrong, `verify_changes` with an image. Do not `edit_table` unless the user asked to change the grid.
5. Save only as HWPX. If a path would write binary `.hwp`, stop and tell the user this pack refuses that format.
