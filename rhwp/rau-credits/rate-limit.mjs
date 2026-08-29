/** 고정 창 카운터. 같은 키가 창 안에서 max 번을 넘으면 false. */
export function createRateLimiter({ now = Date.now, maxKeys = 10_000 } = {}) {
  const buckets = new Map();
  return {
    check(key, max, windowMs) {
      const stamp = now();
      const cutoff = stamp - windowMs;
      if (buckets.size >= maxKeys) {
        for (const [k, bucket] of buckets) {
          if (bucket.windowStart <= cutoff) buckets.delete(k);
        }
      }
      const bucket = buckets.get(key);
      if (!bucket || bucket.windowStart <= cutoff) {
        if (!bucket && buckets.size >= maxKeys) return false;
        buckets.set(key, { windowStart: stamp, count: 1 });
        return true;
      }
      bucket.count += 1;
      return bucket.count <= max;
    },
  };
}
