import type {
  SpeedtestLatencyStats,
  SpeedtestLoadedLatency,
  SpeedtestThroughputStats,
  SpeedtestVerdict,
} from './types.ts'

/**
 * Verdict thresholds, explicit by design so operators can reason about a reported verdict:
 * - critical: average throughput below the configured minimum on either direction
 *   (test failures/timeouts are reported as errors upstream, before any verdict exists);
 * - unstable: jitter above `unstableMinJitterMs`, throughput CV above `unstableMinCv`
 *   on at least one direction, or bufferbloat above `unstableMinBufferbloatMs`;
 * - optimal: jitter below `optimalMaxJitterMs`, throughput CV below `optimalMaxCv`
 *   on both directions, and bufferbloat below `optimalMaxBufferbloatMs` when measured;
 * - good: everything in between.
 *
 * The bufferbloat checks only apply when the result carries a loaded-latency measure.
 */
export interface SpeedtestVerdictThresholds {
  minDownloadMbps: number
  minUploadMbps: number
  optimalMaxJitterMs: number
  optimalMaxCv: number
  optimalMaxBufferbloatMs: number
  unstableMinJitterMs: number
  unstableMinCv: number
  unstableMinBufferbloatMs: number
}

export const SpeedtestDefaultThresholds: SpeedtestVerdictThresholds = {
  minDownloadMbps: 2,
  minUploadMbps: 1,
  optimalMaxJitterMs: 10,
  optimalMaxCv: 0.15,
  optimalMaxBufferbloatMs: 30,
  unstableMinJitterMs: 30,
  unstableMinCv: 0.3,
  unstableMinBufferbloatMs: 100,
}

export function computeVerdict(
  measures: {
    latency: SpeedtestLatencyStats
    download: SpeedtestThroughputStats
    upload: SpeedtestThroughputStats
    loadedLatency?: undefined | SpeedtestLoadedLatency
  },
  thresholds: SpeedtestVerdictThresholds = SpeedtestDefaultThresholds,
): SpeedtestVerdict {
  const {latency, download, upload, loadedLatency} = measures

  if (download.avgMbps < thresholds.minDownloadMbps || upload.avgMbps < thresholds.minUploadMbps) {
    return 'critical'
  }
  if (
    latency.jitterMs > thresholds.unstableMinJitterMs ||
    download.stabilityCv > thresholds.unstableMinCv ||
    upload.stabilityCv > thresholds.unstableMinCv ||
    (loadedLatency !== undefined && loadedLatency.bufferbloatMs > thresholds.unstableMinBufferbloatMs)
  ) {
    return 'unstable'
  }
  if (
    latency.jitterMs < thresholds.optimalMaxJitterMs &&
    download.stabilityCv < thresholds.optimalMaxCv &&
    upload.stabilityCv < thresholds.optimalMaxCv &&
    (loadedLatency === undefined || loadedLatency.bufferbloatMs < thresholds.optimalMaxBufferbloatMs)
  ) {
    return 'optimal'
  }
  return 'good'
}
