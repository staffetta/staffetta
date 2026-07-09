import type {
  SpeedtestLatencyStats,
  SpeedtestLoadedLatency,
  SpeedtestThroughputStats,
  SpeedtestTransferChunk,
} from './types.ts'

export function computeLatencyStats(rttSamplesMs: Array<number>): SpeedtestLatencyStats {
  return {
    avgMs: roundTo(computeMean(rttSamplesMs), 1),
    minMs: roundTo(Math.min(...rttSamplesMs), 1),
    maxMs: roundTo(Math.max(...rttSamplesMs), 1),
    p50Ms: roundTo(computePercentile(rttSamplesMs, 50), 1),
    p90Ms: roundTo(computePercentile(rttSamplesMs, 90), 1),
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
  // The CV drives the verdict, so it excludes the single best and worst window: an isolated
  // sampling artifact (a burst or a scheduling gap of the harness) is not instability, a
  // pattern of dips is. min/max stay raw — they are descriptive, not judged.
  const stabilitySamples = trimExtremes(samplesMbps)
  const stabilityMean = computeMean(stabilitySamples)

  return {
    avgMbps: roundTo(avgMbps ?? mean, 2),
    minMbps: roundTo(Math.min(...samplesMbps), 2),
    maxMbps: roundTo(Math.max(...samplesMbps), 2),
    p50Mbps: roundTo(computePercentile(samplesMbps, 50), 2),
    p90Mbps: roundTo(computePercentile(samplesMbps, 90), 2),
    stabilityCv: roundTo(stabilityMean > 0 ? computeStdDev(stabilitySamples) / stabilityMean : 0, 3),
  }
}

/** Drops the single lowest and highest value; too few samples pass through untrimmed. */
function trimExtremes(values: Array<number>): Array<number> {
  if (values.length < 5) {
    return values
  }
  return [...values].sort((a, b) => a - b).slice(1, -1)
}

/**
 * Combines the RTT probes collected while the transfers ran into the loaded-latency measure.
 * Returns `undefined` when either direction has no samples (probes disabled or phase too
 * short), so the result field is either complete or absent.
 */
export function computeLoadedLatency(
  idle: SpeedtestLatencyStats,
  downloadRttSamplesMs: Array<number>,
  uploadRttSamplesMs: Array<number>,
): SpeedtestLoadedLatency | undefined {
  if (downloadRttSamplesMs.length === 0 || uploadRttSamplesMs.length === 0) {
    return undefined
  }

  const download = computeLatencyStats(downloadRttSamplesMs)
  const upload = computeLatencyStats(uploadRttSamplesMs)

  return {
    download,
    upload,
    bufferbloatMs: roundTo(Math.max(0, Math.max(download.p50Ms, upload.p50Ms) - idle.p50Ms), 1),
  }
}

/**
 * Spreads one completed transfer (e.g. an upload POST, whose bytes are only observable at
 * completion) uniformly over its duration as sampling-window-sized chunks, so the fixed-window
 * throughput sampling sees a flow instead of a single spike at the completion timestamp.
 */
export function spreadTransferChunks(args: {
  bytes: number
  endMs: number
  elapsedMs: number
  intervalMs: number
}): Array<SpeedtestTransferChunk> {
  const {bytes, endMs, elapsedMs, intervalMs} = args

  if (elapsedMs <= 0 || intervalMs <= 0) {
    return [{bytes, atMs: endMs}]
  }

  const piecesCount = Math.max(1, Math.ceil(elapsedMs / intervalMs))
  const pieceBytes = bytes / piecesCount
  const startMs = endMs - elapsedMs

  return Array.from({length: piecesCount}, (_, idx) => ({
    bytes: pieceBytes,
    atMs: startMs + ((idx + 1) / piecesCount) * elapsedMs,
  }))
}

/**
 * Buckets the received chunks into fixed time windows and returns the throughput of each
 * window. Windows without data count as 0 Mbps: a stall is instability, not a missing sample.
 * The last window absorbs the trailing remainder (running interval..2×interval long): a short
 * partial window would turn the few bytes landing there into a noisy rate spike, skewing
 * min/max/percentiles/CV.
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

  const windowsCount = Math.max(1, Math.floor(totalMs / intervalMs))
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

/** Percentile (0–100) with linear interpolation between the two nearest ranks. */
export function computePercentile(values: Array<number>, percentile: number): number {
  if (values.length === 0) {
    return 0
  }

  const sorted = [...values].sort((a, b) => a - b)
  const rank = (Math.min(100, Math.max(0, percentile)) / 100) * (sorted.length - 1)
  const lowIdx = Math.floor(rank)
  const highIdx = Math.ceil(rank)

  const low = sorted[lowIdx] ?? 0
  const high = sorted[highIdx] ?? low

  return low + (high - low) * (rank - lowIdx)
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
