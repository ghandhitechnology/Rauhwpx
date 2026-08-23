# Document runtime integration

The production worker image must place `run.mjs` in this directory. It exports:

```js
export async function runSession({ manifest, workspace, credentials, client }) {
  return {
    timelinePath: '/workspace/timeline.json',
    resultPath: '/workspace/result.hwpx',
    resultName: 'result.hwpx',
  };
}
```

`manifest.resources` contains digest-verified local files. `client` records replayable events, checkpoints, turn boundaries, queued messages, suspension, and the final result. The returned timeline must contain the complete portable timeline after the final turn. The worker publishes it before completing the result. The Studio headless runtime owns document semantics and provider CLI execution.
