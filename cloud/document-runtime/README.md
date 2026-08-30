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

`manifest.resources` contains digest-verified local files. `client` records replayable events, checkpoints, turn boundaries, queued messages, suspension, and the final result. The returned timeline must contain the complete portable timeline after the final turn. The worker publishes it before completing the result. The Studio headless runtime owns document semantics and provider CLI execution.

## Session display

Each cloud session owns one virtual desktop (`SessionDisplay` in `session-display.mjs`). The worker starts Xvfb before `runSession`, passes `DISPLAY` / `XAUTHORITY` into the hub via `studio-harness.mjs`, and stops the display when the session ends.

Status is a state machine: `starting → ready → stopped`, with `error → starting` for one automatic restart. Display death is fail-soft — document MCP tools stay up. Timeline messages with `kind: 'environment'` carry the same event shape the worker logs (`environment.display_ready`, `environment.display_restarted`, …).

Agents capture the screen with `environment_screenshot` (writes under `{workDir}/.rhwp-agent/screens/`) and place the PNG with `insert_image`. There is no live Studio viewer of the virtual desktop in this runtime.
