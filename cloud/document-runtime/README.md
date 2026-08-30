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

## Session display

Each cloud session attempts one virtual desktop startup (`SessionDisplay` in `session-display.mjs`). The worker fixes the browser mode from that result before launching Studio. A ready display launches headed Chromium at the display's exact dimensions with its `DISPLAY` / `XAUTHORITY`; an unavailable display launches headless Chromium and never opens a frame capability for that harness.

The live Studio viewer is demand-driven. Its frame stream may open before Studio, but ffmpeg starts only after the document and chat runtime are ready; viewer demand before then remains waiting. ffmpeg stays in the worker process group. Graceful teardown signals the direct child with `SIGTERM`, then `SIGKILL`; abrupt worker teardown is owned by LocalRunner or Podman.

The worker disables Xvfb restarts after fixing browser mode. Display loss in headed mode raises `DISPLAY_LOST`; Chromium loss raises `BROWSER_EXITED`. Durable user-input waits check both at 250 ms intervals and fail through the normal worker suspension and recovery path.

Agents can also capture the same virtual desktop with `environment_screenshot` and place its PNG with `insert_image`.
