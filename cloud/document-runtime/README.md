# Document runtime integration

The production worker image must place `run.mjs` in this directory. It exports:

```js
export async function runSession({ manifest, workspace, credentials, client, sessionDisplay }) {
  return {
    timelinePath: '/workspace/timeline.json',
    resultPath: '/workspace/result.hwpx',
    resultName: 'result.hwpx',
  };
}
```

`manifest.resources` contains digest-verified local files. `client` records replayable events, checkpoints, turn boundaries, queued messages, suspension, and the final result. The returned timeline must contain the complete portable timeline after the final turn. The worker publishes it before completing the result. Studio owns document semantics and provider CLI execution.

Checkpoints are archived automatically after operations and turns. Updating the origin file requires the user's **원본에 반영** action or the agent's `publish_cloud_document` tool. The tool requests publication after its turn succeeds; the runtime emits a durable `document.publish_requested` event pointing to that turn's checkpoint. Interrupted and failed turns do not publish. Publication preserves the active cloud conversation and checks the origin digest before replacing a file; external edits produce a separate recovery copy.

The harness registers each Studio session through the hub's owner endpoint and supplies separate Studio, reference, and template capabilities. Its IPC secret broker stores hub-managed secrets in session-local memory and clears them when the harness closes.

## Session display

The worker opens `/document.html`, a document-only shell served by the harness.
It reuses the existing Studio build, WASM, fonts, and images without rebuilding
them. The shell keeps the initialization nodes required by the shared editor,
but hides application chrome before first paint and gives the document the full
viewport. This also applies to `/` and `/index.html` on the worker's loopback
server. Normal Studio builds and authenticated resource downloads are unchanged.

Railway runs the image selected by the desktop or hosted provisioner, not the
current Git branch. Both defaults must point to a published image containing the
shell. `1.1.0-edge.19-document-input` adds the corrected shell to `1.1.0-edge.17` without
rebuilding its engines or Studio assets. The image workflow's
`document_shell_only` input uses `Containerfile.document-shell` and verifies the
real document layout before publication. The editor's transparent keyboard/IME
input must remain focusable beside the scroll container. A worker checks focus,
pointer access, and layout before making its display ready. The original
`edge.18-document-only` shell hides that input and must be replaced by a build
containing the input fix.

Existing sandboxes keep their original image. After updating the app or hosted
broker, start a new Cloud instance to use the new default. An explicit
`RAUHWpx_RAILWAY_IMAGE` override must also select an image with the shell.

To verify the production viewer against a real document locally, build with
`VITE_RHWP_CLOUD_RUNTIME=1 npm --prefix rhwp/rhwp-studio run build`, then run
`npm --prefix rhwp/rhwp-studio run e2e:cloud-document`. This sends actual pointer
and keyboard events through the viewer input queue to a separate browser running
the published document shell. It checks Korean text at three viewport sizes and
preserves every edit through HWPX export/reopen. Screenshots and the edited HWPX
are saved under `rhwp/rhwp-studio/sidebar-preview/artifacts/cloud-document/`.

The `edge.19-document-input` release passed the [Linux image checks](https://github.com/ghandhitechnology/Rauhwpx/actions/runs/34014062384)
and a separate Railway verification on 2026-09-06. The hosted check used
`docs/diagnostics/cloud-hosted-document-proof.mjs`, native Xvfb capture, and the
image's bundled HWP sample. A native click focused the editor, Korean input
advanced its revision from 0 to 4, and the exported HWPX contained the text exactly
once. The [captured hosted screen](../../docs/evidence/cloud-document-hosted-after.jpg)
shows the edited document without application chrome or a warning. The temporary
verification service was removed. The production broker now explicitly selects
this image through `RAUHWpx_RAILWAY_IMAGE`.

Each cloud session attempts one virtual desktop startup (`SessionDisplay` in `session-display.mjs`). The worker fixes the browser mode from that result before launching Studio. A ready display launches headed Chromium at the display's exact dimensions with its `DISPLAY` / `XAUTHORITY`; an unavailable display launches headless Chromium and never opens a frame capability for that harness.

The live Studio viewer is demand-driven. Its frame stream may open before Studio, but ffmpeg starts only after the document and chat runtime are ready; viewer demand before then remains waiting. ffmpeg stays in the worker process group. Graceful teardown signals the direct child with `SIGTERM`, then `SIGKILL`; abrupt worker teardown is owned by LocalRunner or Podman.

The worker disables Xvfb restarts after fixing browser mode. Display loss in headed mode raises `DISPLAY_LOST`; Chromium loss raises `BROWSER_EXITED`. Durable user-input waits check both at 250 ms intervals and fail through the normal worker suspension and recovery path.

Agents can also capture the same virtual desktop with `environment_screenshot` and place its PNG with `insert_image`.
