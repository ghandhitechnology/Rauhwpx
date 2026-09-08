/** Main-process wake and network-edge triggers. Endpoint probes still decide whether Cloud is reachable. */
export function installCloudContinuityTriggers({
  powerMonitor,
  isOnline,
  reconcile,
  pollMs = 10_000,
  setIntervalImpl = setInterval,
  clearIntervalImpl = clearInterval,
} = {}) {
  let stopped = false;
  let online = Boolean(isOnline());
  const run = (reason) => {
    if (stopped || !isOnline()) return;
    void Promise.resolve(reconcile({ reason })).catch(() => {});
  };
  const onResume = () => run('resume');
  const onUnlock = () => run('unlock');
  powerMonitor.on('resume', onResume);
  powerMonitor.on('unlock-screen', onUnlock);
  const timer = setIntervalImpl(() => {
    const next = Boolean(isOnline());
    if (next && !online) run('online');
    online = next;
  }, pollMs);
  timer.unref?.();
  run('startup');
  return () => {
    if (stopped) return;
    stopped = true;
    clearIntervalImpl(timer);
    powerMonitor.removeListener('resume', onResume);
    powerMonitor.removeListener('unlock-screen', onUnlock);
  };
}
