# Plan presentation

The plan reads as a document within the conversation. A larger title introduces the goal, numbered steps show the proposed changes, and the active step receives a subtle provider-colored background. Validation has its own inset area. Sources and approval remain in the same scrolling sheet.

The redesign is scoped to `plan-presentation.css`, imported after the existing sidebar stylesheet. Removing that import restores the previous presentation. No rendering conditions, handlers, protocol, text, or DOM structure changed.

| Area | Before | After |
| --- | --- | --- |
| Tokens | Shared sidebar surface and border | Existing theme tokens plus scoped 10% text border and 7% accent wash |
| Typography | 16px title, 12px step title, 11px previews | 21px title, 13px step title, 12px previews; existing Korean font |
| Spacing | 2px internal edge padding, 10px step rows | 20px document inset, 12px step rows, 24px section gaps |
| Color | Uniform sunken surface | Theme-aware document surface, muted validation inset |
| Components | Bare numbers and repeated horizontal rules | 26px numbered markers, open-detail guide, 40px actions |
| Depth | Flat sheet | 14px document corners and subtle border |
| Motion | Existing sheet and checklist animations | Existing motion retained; 160ms hover and press feedback; reduced-motion overrides |

The sidebar renderer and bridge are behavior-sensitive and were left intact, except for the stylesheet import. The new stylesheet contains only presentation rules. Existing styles remain available for rollback.

## Evidence

- [Before](before.png) and [after](after.png)
- [Sources and approval](plan-actions.png)
- [Active checklist](plan-running.png)
- [Narrow dark layout](plan-narrow-dark.png)
- [Before recording](before.webm) and [after recording](after.webm)

Captures use the production sidebar with local preview fixtures. The browser checks exercise discussion, revision, checklist progress, focus retention, approval, and narrow dark layout. Full document-engine execution is outside this preview.
