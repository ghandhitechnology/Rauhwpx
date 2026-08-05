---
target: the whole rhwp-studio page
total_score: 22
max_score: 40
na_heuristics: 
p0_count: 0
p1_count: 4
timestamp: 2026-08-05T08-21-18Z
slug: rhwp-rhwp-studio-index-html
---
# Impeccable Critique — rhwp-studio

## Design Health Score

| # | Heuristic | Score | Key Issue |
|---|-----------|------:|-----------|
| 1 | Visibility of System Status | 2 | Status exists, but the empty editor and agent-unavailable states do not provide a clear next action. |
| 2 | Match System / Real World | 3 | Strong Korean/HWP vocabulary; provider jargon and playful placeholder copy weaken the office-tool voice. |
| 3 | User Control and Freedom | 3 | Undo and AI approval are strong; sidebar collapse is not reliably keyboard-operable. |
| 4 | Consistency and Standards | 2 | Modern neutral sidebar conflicts with legacy sprites, Unicode icons, tiny labels, and dense toolbar chrome. |
| 5 | Error Prevention | 3 | Disabled commands, permissions, and review-before-apply are solid guardrails. |
| 6 | Recognition Rather Than Recall | 2 | Commands are labeled, but ambiguous glyphs and dense formatting controls demand prior knowledge. |
| 7 | Flexibility and Efficiency | 3 | Shortcuts and sidebar resizing help experts; the always-visible command surface remains overloaded. |
| 8 | Aesthetic and Minimalist Design | 1 | Roughly 42 toolbar buttons plus 32 style controls dominate the first viewport. |
| 9 | Error Recovery | 2 | Errors are surfaced, but connection/replaced-tab states lack recovery actions. |
| 10 | Help and Documentation | 1 | No visible first-run guidance or contextual help. |
| **Total** | | **22/40** | **Acceptable, but significant improvement needed** |

## Design Specificity Verdict

**Partly product-specific, visually category-interchangeable.** Korean HWP terminology and human-approved AI edits are genuinely rhwp-specific, but the first viewport reads as a legacy desktop word processor with a generic AI side panel. The agent header emphasizes provider, model, effort, and permission settings instead of the current document, selection, or pending edits.

The deterministic scan returned zero findings for `index.html`. That is not a clean bill of health: the sidebar is mounted dynamically from `src/ui/agent-sidebar/index.ts`, while responsive and touch behavior live in CSS. Browser and source evidence found runtime, mobile, and accessibility issues the static scan cannot see. No false positives were produced.

No visual overlay was injected because the available browser evaluation surface was read-only. Desktop/mobile screenshots, DOM snapshots, computed geometry, console logs, and source inspection were used instead.

## Overall Impression

The underlying design system is more modern than the page feels. Neutral surfaces, restrained agent colors, clear approval/rejection, and reduced-motion support are sound. The dated impression comes from command density, mixed icon eras, undersized type and controls, and a blank opening state. The biggest opportunity is to make the document and the user's current task visually primary, then reveal tools progressively.

## What's Working

- Human control is built into the product model: pending edits and explicit approve/reject make the AI safer than generic auto-writing chat.
- The neutral token system, dark theme, focus styling, and reduced-motion rules provide a disciplined foundation.
- Korean-first terminology, familiar document concepts, and visible shortcuts respect experienced HWP users.

## Priority Issues

### [P1] Sidebar collapse is one action described by three timing systems

**Why it matters:** The sidebar transform and editor margin run for 220ms with an aggressive ease-out, while the JavaScript recenter loop runs for 280ms. The panel appears to sprint away while the document continues adjusting, creating the reported snap/chase feeling.

**Fix:** Use one 300–340ms duration and one calmer ease for panel transform, editor inset, chevron, and recentering. Match the JS loop exactly or reduce the system to one authoritative resize/recenter path. Separate collapse from resize instead of making the same narrow tab perform both.

**Suggested command:** `$impeccable animate`

### [P1] The toolbar is the main source of the early-2000s impression

**Why it matters:** Roughly 42 icon-toolbar buttons and 32 style controls appear at once. Tiny 10px labels, 18px legacy sprites, frequent separators, and mixed Unicode pseudo-icons create a dense raster even though the color palette is modern.

**Fix:** Keep 8–12 universal commands visible, move secondary tools into contextual groups or overflow, and replace the sprite/text-glyph mixture with one coherent vector family. Increase essential labels to 11–12px and use spacing plus grouping to create hierarchy.

**Suggested command:** `$impeccable distill`

### [P1] The first-run state looks empty or broken, not ready

**Why it matters:** On desktop, the only open-document guidance is low-priority status text. On mobile, `.stb-message` hides that instruction entirely, leaving a blank canvas with no visible first step. The AI pane also lacks a useful activation/recovery state.

**Fix:** Add a centered `HWP/HWPX 열기` action, drag/drop cue, and recent files. Give the agent pane a compact state card and 2–3 document-native starter actions such as summary, proofreading, or rewriting the current selection.

**Suggested command:** `$impeccable onboard`

### [P1] Core navigation and sidebar collapse are not reliably keyboard-operable

**Why it matters:** Top-level menu titles are spans and dropdown entries are divs without menu semantics or tab stops; opening is wired to `mousedown`. The sidebar button suppresses normal click behavior and relies on pointer events. Keyboard and screen-reader users can struggle to reach File → Open or toggle the agent pane.

**Fix:** Use semantic buttons/menu roles with roving focus and arrow-key behavior. Restore semantic click activation for the sidebar toggle, reserving pointer movement beyond a threshold for a distinct resize handle.

**Suggested command:** `$impeccable audit`

### [P2] Mobile is compressed desktop chrome rather than a deliberate mode

**Why it matters:** At 390px wide, chrome consumes about 248px or 29% of the viewport height. Many controls remain 24–36px, below a comfortable 44px touch target, while the open sidebar covers about 72% of the viewport.

**Fix:** Replace wrapped toolbars with a compact mobile command row and contextual bottom sheet. Raise primary touch targets to 44px and keep only document, undo/redo, formatting entry, and AI entry visible by default.

**Suggested command:** `$impeccable adapt`

## Persona Red Flags

**Alex, power user:** Extensive shortcuts help, but the dense toolbar slows scanning and the sidebar's fast inset/recenter motion disrupts spatial continuity. Keyboard collapse fails, so a high-frequency layout action becomes pointer-dependent.

**Jordan, first-timer:** The blank workspace has no prominent open action. The AI pane foregrounds `Sonnet 5`, `High`, permissions, and connection state before explaining what can be done with an HWP document. On mobile, even the small file-selection instruction disappears.

**Sam, keyboard/low-vision user:** File menu items are not exposed as actionable menu controls, the sidebar toggle mixes resize and collapse semantics, 10px toolbar labels are fatiguing, and many mobile targets are materially below 44px.

## Minor Observations

- `딸깍해보자..` is tonally playful but grammatically rough and mismatched with a trusted office tool.
- `다른 탭에서 사용 중` needs an action such as `이 탭에서 연결` or explicit recovery instructions.
- The 360px sidebar width is reasonable; its empty body makes the imbalance feel larger.
- The sidebar's newer neutral styling makes the legacy toolbar era more visible, not less.
- The collapse affordance shows a chevron for toggle but uses a `col-resize` cursor, sending conflicting signals.

## Questions to Consider

- If AI is first-class, why does its header emphasize model configuration more than the open document and current selection?
- Which ten commands genuinely deserve permanent visibility before a document is open?
- Should collapsing preserve the user's spatial map, or merely finish as quickly as possible?
- Should the blank editor communicate “nothing loaded,” or “your next Korean document starts here”?
