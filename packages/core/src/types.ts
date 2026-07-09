export type SpeedtestPhase = 'ping' | 'download' | 'upload'

export type SpeedtestVerdict = 'optimal' | 'good' | 'unstable' | 'critical'

export interface SpeedtestConfig {
  /** Measured ping requests (an extra warm-up request is always sent first and discarded). */
  pingCount: number
  /** Bytes transferred by the download phase and (in total) by the upload phase. */
  transferSizeBytes: number
  /** Sequential upload chunks; each chunk produces one throughput sample for the stability CV. */
  uploadChunkCount: number
  /** Width of the download throughput sampling window. */
  sampleIntervalMs: number
  /** Safety timeout applied to each phase. */
  phaseTimeoutMs: number
}

export const SpeedtestDefaultConfig: SpeedtestConfig = {
  pingCount: 16,
  transferSizeBytes: 24 * 1024 * 1024, // 24 MiB
  uploadChunkCount: 8,
  sampleIntervalMs: 250,
  phaseTimeoutMs: 240_000,
}

export interface SpeedtestLatencyStats {
  avgMs: number
  minMs: number
  maxMs: number
  /** Standard deviation of the RTT samples. */
  jitterMs: number
}

export interface SpeedtestThroughputStats {
  avgMbps: number
  minMbps: number
  maxMbps: number
  /** Coefficient of variation (standard deviation / mean) of the throughput samples. */
  stabilityCv: number
}

/** Live progress sample emitted while a phase runs (one line of a "ping-like" live log). */
export type SpeedtestProgressSample =
  | {phase: 'ping'; seq: number; rttMs: number}
  | {phase: 'download'; mbps: number; transferredBytes: number; totalBytes: number}
  | {phase: 'upload'; seq: number; mbps: number; transferredBytes: number; totalBytes: number}

export interface SpeedtestResult {
  /** ISO 8601. */
  timestamp: string
  /** Base URL of the server under test. */
  target: string
  latency: SpeedtestLatencyStats
  download: SpeedtestThroughputStats
  upload: SpeedtestThroughputStats
  verdict: SpeedtestVerdict
}

/** One received chunk, timestamped for the fixed-window throughput sampling. */
export interface SpeedtestTransferChunk {
  bytes: number
  atMs: number
}
