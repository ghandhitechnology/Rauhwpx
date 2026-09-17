/** Main-process wake, cadence, and network-edge triggers. Endpoint probes still decide whether Cloud is reachable. */
export function installCloudContinuityTriggers({
  powerMonitor,
  isOnline,
  reconcile,
  keepWarm = null,
  pollMs = 10_000,
  reconcileEveryMs = 60_000,
  keepWarmMs = 20 * 60_000,
  setIntervalImpl = setInterval,
  clearIntervalImpl = clearInterval,
} = {}) {
  let stopped = false;
  let online = Boolean(isOnline());
  const run = (reason) => {
    if (stopped || !isOnline()) return;
    void Promise.resolve(reconcile({ reason })).catch(() => {});
  };
  const warm = (reason) => {
    if (stopped || !isOnline() || !keepWarm) return;
    void Promise.resolve(keepWarm({ reason })).catch(() => {});
  };
  const onResume = () => {
    run('resume');
    warm('resume');
  };
  const onUnlock = () => {
    run('unlock');
    warm('unlock');
  };
  powerMonitor.on('resume', onResume);
  powerMonitor.on('unlock-screen', onUnlock);
  const edgeTimer = setIntervalImpl(() => {
    const next = Boolean(isOnline());
    if (next && !online) run('online');
    online = next;
  }, pollMs);
  edgeTimer.unref?.();
  // A finished Cloud turn has to reach the desktop without the user opening the
  // sidebar, so reconcile on a slow cadence instead of only on wake edges.
  const reconcileTimer = setIntervalImpl(() => run('cadence'), reconcileEveryMs);
  reconcileTimer.unref?.();
  // The reservation expires with the broker's idle window, so an open app renews it.
  const warmTimer = keepWarm ? setIntervalImpl(() => warm('keep-warm'), keepWarmMs) : null;
  warmTimer?.unref?.();
  run('startup');
  warm('startup');
  return () => {
    if (stopped) return;
    stopped = true;
    for (const timer of [edgeTimer, reconcileTimer, warmTimer]) {
      if (timer) clearIntervalImpl(timer);
    }
    powerMonitor.removeListener('resume', onResume);
    powerMonitor.removeListener('unlock-screen', onUnlock);
  };
}
