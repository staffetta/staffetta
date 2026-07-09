import type {SpeedtestLatencyStats, SpeedtestThroughputStats, SpeedtestTransferChunk} from './types.ts'

export function computeLatencyStats(rttSamplesMs: Array<number>): SpeedtestLatencyStats {
  return {
    avgMs: roundTo(computeMean(rttSamplesMs), 1),
    minMs: roundTo(Math.min(...rttSamplesMs), 1),
    maxMs: roundTo(Math.max(...rttSamplesMs), 1),
    jitterMs: roundTo(computeStdDev(rttSamplesMs), 1),
  }
}

/**
 * The average defaults to the mean of the samples but callers should pass the whole-transfer
 * average (total bytes / total time) when available, which is not skewed by window boundaries.
 */
export function computeThroughputStats(
  samplesMbps: Array<number>,
  avgMbps?: undefined | number,
): SpeedtestThroughputStats {
  const mean = computeMean(samplesMbps)

  return {
    avgMbps: roundTo(avgMbps ?? mean, 2),
    minMbps: roundTo(Math.min(...samplesMbps), 2),
    maxMbps: roundTo(Math.max(...samplesMbps), 2),
    stabilityCv: roundTo(mean > 0 ? computeStdDev(samplesMbps) / mean : 0, 3),
  }
}

/**
 * Buckets the received chunks into fixed time windows and returns the throughput of each
 * window. Windows without data count as 0 Mbps: a stall is instability, not a missing sample.
 * The last window uses its real (shorter) duration.
 */
export function computeThroughputSamplesMbps(
  chunks: Array<SpeedtestTransferChunk>,
  args: {startMs: number; endMs: number; intervalMs: number},
): Array<number> {
  const {startMs, endMs, intervalMs} = args
  const totalMs = endMs - startMs

  if (totalMs <= 0 || intervalMs <= 0) {
    return []
  }

  const windowsCount = Math.ceil(totalMs / intervalMs)
  const windowsBytes = Array.from({length: windowsCount}, () => 0)

  for (const chunk of chunks) {
    const windowIdx = Math.min(windowsCount - 1, Math.max(0, Math.floor((chunk.atMs - startMs) / intervalMs)))
    windowsBytes[windowIdx] = (windowsBytes[windowIdx] ?? 0) + chunk.bytes
  }

  return windowsBytes.map((bytes, idx) => {
    const windowMs = idx === windowsCount - 1 ? totalMs - idx * intervalMs : intervalMs
    return bytesToMbps(bytes, windowMs)
  })
}

export function bytesToMbps(bytes: number, elapsedMs: number): number {
  if (elapsedMs <= 0) {
    return 0
  }
  return (bytes * 8) / 1000 / elapsedMs
}

export function computeMean(values: Array<number>): number {
  if (values.length === 0) {
    return 0
  }
  return values.reduce((sum, it) => sum + it, 0) / values.length
}

/** Population standard deviation. */
export function computeStdDev(values: Array<number>): number {
  if (values.length === 0) {
    return 0
  }

  const mean = computeMean(values)
  const variance = values.reduce((sum, it) => sum + (it - mean) ** 2, 0) / values.length

  return Math.sqrt(variance)
}

export function roundTo(value: number, decimals: number): number {
  const factor = 10 ** decimals
  return Math.round(value * factor) / factor
}
