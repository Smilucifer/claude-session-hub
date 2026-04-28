// Filters Claude account-usage updates so a stale low-pct snapshot from a
// freshly-launched / long-idle session can't overwrite the true usage from a
// heavy session. rate_limits is monotonically increasing within a window, so:
//   - new resetsAt window  → accept the new value
//   - same window          → accept only if pct >= last accepted pct
function shouldAcceptUsage(prev, next) {
  if (!next) return false;
  if (!prev) return true;
  if (Math.abs((next.resetsAt || 0) - (prev.resetsAt || 0)) > 60_000) return true;
  return (next.pct || 0) >= (prev.pct || 0);
}

function createUsageFilter() {
  const accepted = { usage5h: null, usage7d: null };

  return {
    seed(cached) {
      if (!cached) return;
      if (cached.usage5h) accepted.usage5h = cached.usage5h;
      if (cached.usage7d) accepted.usage7d = cached.usage7d;
    },
    filter(rawUsage5h, rawUsage7d) {
      const ok5 = shouldAcceptUsage(accepted.usage5h, rawUsage5h);
      const ok7 = shouldAcceptUsage(accepted.usage7d, rawUsage7d);
      if (ok5) accepted.usage5h = rawUsage5h;
      if (ok7) accepted.usage7d = rawUsage7d;
      return {
        usage5h: ok5 ? rawUsage5h : null,
        usage7d: ok7 ? rawUsage7d : null,
        anyAccepted: ok5 || ok7,
      };
    },
    snapshot() {
      return { usage5h: accepted.usage5h, usage7d: accepted.usage7d };
    },
  };
}

module.exports = { shouldAcceptUsage, createUsageFilter };
