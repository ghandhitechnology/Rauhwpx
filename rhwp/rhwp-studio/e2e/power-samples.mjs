/** Parse powermetrics' externally captured one-second samples. */
export function summarizePower(logText, startMs, endMs) {
  const samples = [];
  const blockRe = /\*\*\* Sampled system activity \(([^)]+)\) \(([-+\d.]+)ms elapsed\) \*\*\*([\s\S]*?)(?=\n\*\*\* Sampled system activity |$)/g;
  let match;
  while ((match = blockRe.exec(logText))) {
    const timestampMs = Date.parse(match[1]);
    const elapsedMs = Number(match[2]);
    if (!Number.isFinite(timestampMs) || !Number.isFinite(elapsedMs)) continue;
    // powermetrics timestamps are whole seconds. Include intervals overlapping
    // the workload with a one-second edge guard for timestamp rounding.
    if (timestampMs + elapsedMs < startMs - 1000 || timestampMs > endMs + 1000) continue;
    const body = match[3];
    const cpu = body.match(/(?:^|\n)CPU Power:\s*([-+\d.]+)\s*mW/)?.[1];
    const gpu = body.match(/(?:^|\n)GPU Power:\s*([-+\d.]+)\s*mW/)?.[1];
    const combined = body.match(/(?:^|\n)Combined Power \(CPU \+ GPU \+ ANE\):\s*([-+\d.]+)\s*mW/)?.[1];
    const active = body.match(/GPU HW active residency:\s*([-+\d.]+)%/)?.[1];
    if (cpu === undefined || gpu === undefined) continue;
    const cpuMw = Number(cpu); const gpuMw = Number(gpu);
    const combinedMw = combined === undefined ? cpuMw + gpuMw : Number(combined);
    if (![cpuMw, gpuMw, combinedMw].every(Number.isFinite)) continue;
    samples.push({ timestampMs, elapsedMs, cpuMw, gpuMw, combinedMw, gpuActivePercent: active === undefined ? null : Number(active) });
  }
  const durationMs = samples.reduce((sum, sample) => sum + sample.elapsedMs, 0);
  const mean = key => samples.length ? samples.reduce((sum, sample) => sum + (sample[key] ?? 0), 0) / samples.length : null;
  return {
    samples,
    sampleCount: samples.length,
    durationMs,
    meanCpuMw: mean('cpuMw'),
    meanGpuMw: mean('gpuMw'),
    meanCombinedMw: mean('combinedMw'),
    meanGpuActivePercent: mean('gpuActivePercent'),
    energyJ: samples.reduce((sum, sample) => sum + sample.combinedMw * sample.elapsedMs / 1e6, 0),
  };
}
