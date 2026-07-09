import type {SpeedtestLatencyStats, SpeedtestThroughputStats, SpeedtestVerdict} from './types.ts'

/**
 * Verdict thresholds, explicit by design so operators can reason about a reported verdict:
 * - critical: average throughput below the configured minimum on either direction
 *   (test failures/timeouts are reported as errors upstream, before any verdict exists);
 * - unstable: jitter above `unstableMinJitterMs` or throughput CV above `unstableMinCv`
 *   on at least one direction;
 * - optimal: jitter below `optimalMaxJitterMs` and throughput CV below `optimalMaxCv`
 *   on both directions;
 * - good: everything in between.
 */
export interface SpeedtestVerdictThresholds {
  minDownloadMbps: number
  minUploadMbps: number
  optimalMaxJitterMs: number
  optimalMaxCv: number
  unstableMinJitterMs: number
  unstableMinCv: number
}

export const SpeedtestDefaultThresholds: SpeedtestVerdictThresholds = {
  minDownloadMbps: 2,
  minUploadMbps: 1,
  optimalMaxJitterMs: 10,
  optimalMaxCv: 0.15,
  unstableMinJitterMs: 30,
  unstableMinCv: 0.3,
}

export function computeVerdict(
  measures: {
    latency: SpeedtestLatencyStats
    download: SpeedtestThroughputStats
    upload: SpeedtestThroughputStats
  },
  thresholds: SpeedtestVerdictThresholds = SpeedtestDefaultThresholds,
): SpeedtestVerdict {
  const {latency, download, upload} = measures

  if (download.avgMbps < thresholds.minDownloadMbps || upload.avgMbps < thresholds.minUploadMbps) {
    return 'critical'
  }
  if (
    latency.jitterMs > thresholds.unstableMinJitterMs ||
    download.stabilityCv > thresholds.unstableMinCv ||
    upload.stabilityCv > thresholds.unstableMinCv
  ) {
    return 'unstable'
  }
  if (
    latency.jitterMs < thresholds.optimalMaxJitterMs &&
    download.stabilityCv < thresholds.optimalMaxCv &&
    upload.stabilityCv < thresholds.optimalMaxCv
  ) {
    return 'optimal'
  }
  return 'good'
}
