// Latency statistics, with no dependencies and no lying.
//
// Three decisions here are worth more than the code:
//
// 1. We keep every sample. A real load tool uses an HDR histogram because it
//    cannot afford the memory; a lab run of a few hundred thousand samples fits
//    comfortably, and exact percentiles beat approximate ones when the whole
//    point of the chapter is that you can trust the number.
//
// 2. We report SPREAD, not just the middle. Every measurement in this course
//    runs on the same machine as the thing it is measuring, so some noise is
//    unavoidable. Hiding it behind a single mean would be dishonest. `cv` (the
//    coefficient of variation) is the number that tells you whether a
//    difference between two runs means anything.
//
// 3. The mean is reported but never used to make a point. Latency distributions
//    are not normal - they have a long right tail, and the mean sits in a
//    region where almost no request actually lands.

// Nearest-rank percentile. No interpolation: with a sorted sample of real
// observations, p99 should be a latency that actually happened.
export function percentile(sorted, p) {
  if (!sorted.length) return null;
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(Math.max(rank, 1), sorted.length) - 1];
}

const round2 = (n) => (n == null ? null : Math.round(n * 100) / 100);

export function summarise(samples) {
  const ok = samples.filter((n) => Number.isFinite(n));
  if (!ok.length) {
    return { count: 0, min: null, p50: null, p90: null, p95: null, p99: null, max: null, mean: null, stddev: null, cv: null };
  }

  const sorted = [...ok].sort((a, b) => a - b);
  const mean = ok.reduce((a, b) => a + b, 0) / ok.length;
  const variance = ok.reduce((acc, n) => acc + (n - mean) ** 2, 0) / ok.length;
  const stddev = Math.sqrt(variance);

  return {
    count: ok.length,
    min: round2(sorted[0]),
    p50: round2(percentile(sorted, 50)),
    p90: round2(percentile(sorted, 90)),
    p95: round2(percentile(sorted, 95)),
    p99: round2(percentile(sorted, 99)),
    max: round2(sorted[sorted.length - 1]),
    mean: round2(mean),
    stddev: round2(stddev),
    // Coefficient of variation, as a percentage. Rule of thumb used throughout
    // this course: above about 30% the run was too noisy to draw a conclusion
    // from, and you should repeat it rather than believe it.
    cv: round2((stddev / mean) * 100)
  };
}

// Given the same measurement repeated, how much did the repeats disagree?
// This is what lets a lesson say "the difference is real" instead of "the
// difference appeared once on my machine".
export function acrossRuns(values) {
  const ok = values.filter((n) => Number.isFinite(n));
  if (ok.length < 2) return { runs: ok.length, spreadPct: null, trustworthy: null };

  const mean = ok.reduce((a, b) => a + b, 0) / ok.length;
  const spread = (Math.max(...ok) - Math.min(...ok)) / mean;
  return {
    runs: ok.length,
    mean: round2(mean),
    spreadPct: round2(spread * 100),
    // Deliberately conservative. If repeats of the same configuration differ by
    // more than a tenth, an effect smaller than that is not an effect.
    trustworthy: spread <= 0.10
  };
}

// A difference is only worth reporting if it is bigger than the noise that
// produced it. Every comparison in this lab goes through this function, so no
// tab can quietly present a 3% win as a result.
export function compare(aStats, bStats, aRuns = [], bRuns = []) {
  if (!aStats?.p50 || !bStats?.p50) return { verdict: 'no data', ratio: null };

  const ratio = bStats.p50 / aStats.p50;
  const noise = Math.max(acrossRuns(aRuns).spreadPct ?? 10, acrossRuns(bRuns).spreadPct ?? 10) / 100;
  const effect = Math.abs(ratio - 1);

  return {
    ratio: round2(ratio),
    changePct: round2((ratio - 1) * 100),
    noiseFloorPct: round2(noise * 100),
    significant: effect > noise,
    verdict: effect > noise
      ? (ratio < 1 ? 'faster, by more than the noise' : 'slower, by more than the noise')
      : 'inside the noise floor - do not draw a conclusion from this'
  };
}
