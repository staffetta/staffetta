import type {
  SpeedtestLatencyStats,
  SpeedtestLoadedLatency,
  SpeedtestThroughputStats,
  SpeedtestVerdict,
  SpeedtestVerdictReason,
} from './types.ts'

/**
 * Verdict thresholds, explicit by design so operators can reason about a reported verdict:
 * - critical: average throughput below the configured minimum on either direction
 *   (test failures/timeouts are reported as errors upstream, before any verdict exists);
 * - unstable: jitter above `unstableMinJitterMs`, throughput CV above `unstableMinCv`
 *   on at least one direction, or idle median RTT above `unstableMinLatencyMs` — a link that
 *   far away is unusable for interactive traffic (calls, gaming, remote shells) no matter how
 *   steady its throughput is;
 * - optimal: jitter below `optimalMaxJitterMs`, throughput CV below `optimalMaxCv`
 *   on both directions, idle median RTT below `optimalMaxLatencyMs`, and bufferbloat below
 *   `optimalMaxBufferbloatMs` when measured;
 * - good: everything in between.
 *
 * The bufferbloat checks only apply when the result carries a loaded-latency measure.
 */
export interface SpeedtestVerdictThresholds {
  minDownloadMbps: number
  minUploadMbps: number
  optimalMaxLatencyMs: number
  optimalMaxJitterMs: number
  optimalMaxCv: number
  optimalMaxBufferbloatMs: number
  unstableMinLatencyMs: number
  unstableMinJitterMs: number
  unstableMinCv: number
  // Opt-in, unset by default: browser probes share the transfer's HTTP/2 connection (separate
  // hostnames get coalesced too), so they also queue behind the server's send buffer and
  // overstate the network's bufferbloat. Set it when the probes are known to travel apart.
  unstableMinBufferbloatMs?: undefined | number
}

export const SpeedtestDefaultThresholds: SpeedtestVerdictThresholds = {
  minDownloadMbps: 2,
  minUploadMbps: 1,
  optimalMaxLatencyMs: 80,
  optimalMaxJitterMs: 10,
  optimalMaxCv: 0.15,
  optimalMaxBufferbloatMs: 30,
  unstableMinLatencyMs: 250,
  unstableMinJitterMs: 30,
  unstableMinCv: 0.3,
}

export interface SpeedtestVerdictMeasures {
  latency: SpeedtestLatencyStats
  download: SpeedtestThroughputStats
  upload: SpeedtestThroughputStats
  loadedLatency?: undefined | SpeedtestLoadedLatency
}

export interface SpeedtestVerdictAssessment {
  verdict: SpeedtestVerdict
  // The measures that held the verdict at its level; empty when optimal.
  reasons: Array<SpeedtestVerdictReason>
}

export function computeVerdict(
  measures: SpeedtestVerdictMeasures,
  thresholds: SpeedtestVerdictThresholds = SpeedtestDefaultThresholds,
): SpeedtestVerdict {
  return assessVerdict(measures, thresholds).verdict
}

export function assessVerdict(
  measures: SpeedtestVerdictMeasures,
  thresholds: SpeedtestVerdictThresholds = SpeedtestDefaultThresholds,
): SpeedtestVerdictAssessment {
  const {latency, download, upload, loadedLatency} = measures
  const bufferbloatMs = loadedLatency?.bufferbloatMs

  const criticalReasons = collectReasons([
    ['download-throughput', download.avgMbps < thresholds.minDownloadMbps],
    ['upload-throughput', upload.avgMbps < thresholds.minUploadMbps],
  ])
  if (criticalReasons.length > 0) {
    return {verdict: 'critical', reasons: criticalReasons}
  }

  const unstableReasons = collectReasons([
    ['latency', latency.p50Ms > thresholds.unstableMinLatencyMs],
    ['jitter', latency.jitterMs > thresholds.unstableMinJitterMs],
    ['download-stability', download.stabilityCv > thresholds.unstableMinCv],
    ['upload-stability', upload.stabilityCv > thresholds.unstableMinCv],
    [
      'bufferbloat',
      bufferbloatMs !== undefined &&
        thresholds.unstableMinBufferbloatMs !== undefined &&
        bufferbloatMs > thresholds.unstableMinBufferbloatMs,
    ],
  ])
  if (unstableReasons.length > 0) {
    return {verdict: 'unstable', reasons: unstableReasons}
  }

  const goodReasons = collectReasons([
    ['latency', latency.p50Ms >= thresholds.optimalMaxLatencyMs],
    ['jitter', latency.jitterMs >= thresholds.optimalMaxJitterMs],
    ['download-stability', download.stabilityCv >= thresholds.optimalMaxCv],
    ['upload-stability', upload.stabilityCv >= thresholds.optimalMaxCv],
    ['bufferbloat', bufferbloatMs !== undefined && bufferbloatMs >= thresholds.optimalMaxBufferbloatMs],
  ])

  return {verdict: goodReasons.length > 0 ? 'good' : 'optimal', reasons: goodReasons}
}

function collectReasons(checks: Array<[SpeedtestVerdictReason, boolean]>): Array<SpeedtestVerdictReason> {
  return checks.filter(([, failed]) => failed).map(([reason]) => reason)
}
