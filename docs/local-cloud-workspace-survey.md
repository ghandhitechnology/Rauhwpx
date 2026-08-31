# Local and cloud workspace survey

## Repository findings

| Area | Current implementation | Takeaway |
| --- | --- | --- |
| Local document and agent | Studio owns the open WASM document. The local hub streams one window-scoped agent session through the sidebar. | Keep this mounted while another workspace is visible so selection, scroll, undo, and chat state survive a switch. |
| Cloud conversation | `origin/feat/persistent-cloud-agent-chat` adds a durable room per document and thread, ordered follow-up messages, signed SSE replay, stable document checkpoints, and desktop/PWA clients. | Integrate this branch as the conversation and document-sync foundation. Do not create a second cloud chat protocol. |
| Cloud document ownership | The cloud runtime is the only writer during a cloud lease. Studio receives verified checkpoints and renders the cloud-owned document as a read-only mirror. | A local view may remain available during cloud work, but local document writes must stay locked until takeover or end. |
| Cloud display | `origin/feat/cloud-session-screens` starts one Xvfb display per worker and exposes screenshots to the agent. Its contract explicitly says there is no live Studio viewer. | The missing backend work is an authenticated viewer transport from that existing display to Studio. |
| Existing cloud UI | Cloud state and commands live in a popover attached to the shared composer. Cloud events are reduced into the current thread timeline. | Preserve one conversation and one composer. Make the execution target explicit instead of adding a second sidebar. |
| Studio layout | The editor and agent sidebar already remain mounted across sidebar and focus modes. The root layout uses state classes and shared motion timing. | Switch the main content and composer target together while retaining both local and cloud DOM state. |

## Related implementations

- [noVNC](https://novnc.com/noVNC/) renders VNC in a browser and carries the protocol over WebSocket, usually through websockify. It is a strong fit when remote pointer and keyboard input are required.
- [websockify](https://github.com/novnc/websockify) bridges browser WebSocket traffic to a TCP VNC server. The bridge can stay inside the authenticated cloud route instead of exposing a VNC port.
- [Apache Guacamole](https://guacamole.apache.org/doc/gug/guacamole-architecture.html) provides a broader remote desktop gateway with a server-side protocol translator. It adds more services than this single Xvfb target needs.

## Implementation direction

Use the persistent cloud conversation branch as the base. Add one authenticated, session-scoped display connection backed by the existing virtual desktop, then mount a local/cloud workspace switch in Studio. Local and cloud views retain their own visual state. The shared timeline keeps handoff continuity, and the composer sends to the selected execution target while the document lease remains the write authority.
