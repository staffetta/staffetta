export type SpeedtestPhase = 'ping' | 'download' | 'upload'

export type SpeedtestVerdict = 'optimal' | 'good' | 'unstable' | 'critical'

export interface SpeedtestConfig {
  /** Measured ping requests (an extra warm-up request is always sent first and discarded). */
  pingCount: number
  /**
   * Target wall-clock duration of each transfer phase. Requests are issued back to back with
   * adaptively growing sizes until it elapses, so the test self-calibrates: slow links move
   * little data, fast links move a lot.
   */
  transferDurationMs: number
  /**
   * Minimum initial portion of each transfer phase excluded from the statistics. The effective
   * warm-up extends adaptively until the windowed throughput reaches steady state (TCP slow
   * start and the size ramp would otherwise deflate min and inflate the stability CV), capped
   * at half the phase so at least half of it is always measured.
   */
  warmupMs: number
  /** Size of the first request of the adaptive ramp. */
  initialRequestSizeBytes: number
  /**
   * Cap for a single ramped request. Must not exceed the server's per-transfer limit
   * (`maxSizeBytes`, 200 MiB on the reference server).
   */
  maxRequestSizeBytes: number
  /** Parallel connections per transfer phase; more streams saturate high-BDP links. */
  connections: number
  /**
   * Interval of the concurrent latency probes sent while download/upload run, used to measure
   * latency under load (bufferbloat). `0` disables the probes and the `loadedLatency` result.
   */
  loadedPingIntervalMs: number
  /** Width of the throughput sampling window. */
  sampleIntervalMs: number
  /** Safety timeout applied to each phase. */
  phaseTimeoutMs: number
}

export const SpeedtestDefaultConfig: SpeedtestConfig = {
  pingCount: 16,
  transferDurationMs: 8000,
  warmupMs: 1000,
  initialRequestSizeBytes: 256 * 1024, // 256 KiB
  maxRequestSizeBytes: 64 * 1024 * 1024, // 64 MiB
  connections: 3,
  loadedPingIntervalMs: 250,
  sampleIntervalMs: 250,
  phaseTimeoutMs: 120_000,
}

export interface SpeedtestLatencyStats {
  avgMs: number
  minMs: number
  maxMs: number
  /** Median RTT, robust to outliers. */
  p50Ms: number
  /** 90th percentile RTT. */
  p90Ms: number
  /** Standard deviation of the RTT samples. */
  jitterMs: number
}

export interface SpeedtestThroughputStats {
  avgMbps: number
  minMbps: number
  maxMbps: number
  /** Median of the windowed throughput samples. */
  p50Mbps: number
  /** 90th percentile of the windowed throughput samples. */
  p90Mbps: number
  /**
   * Coefficient of variation (standard deviation / mean) of the throughput samples, computed
   * excluding the single best and worst window: an isolated sampling artifact is not
   * instability, a pattern of dips is.
   */
  stabilityCv: number
}

/**
 * Latency measured while the link is saturated by the transfer phases. The delta against the
 * idle latency is the classic bufferbloat signal: a connection can be fast and still unusable
 * for calls or gaming when its buffers bloat under load.
 */
export interface SpeedtestLoadedLatency {
  /** RTT stats of the probes sent while the download ran. */
  download: SpeedtestLatencyStats
  /** RTT stats of the probes sent while the upload ran. */
  upload: SpeedtestLatencyStats
  /** Worst-direction median loaded RTT minus the idle median RTT, floored at 0. */
  bufferbloatMs: number
}

/** Live progress sample emitted while a phase runs (one line of a "ping-like" live log). */
export type SpeedtestProgressSample =
  | {phase: 'ping'; seq: number; rttMs: number}
  | {
      phase: 'download' | 'upload'
      kind: 'throughput'
      mbps: number
      transferredBytes: number
      elapsedMs: number
    }
  | {phase: 'download' | 'upload'; kind: 'loaded-ping'; rttMs: number}

export interface SpeedtestResult {
  /** ISO 8601. */
  timestamp: string
  /** Base URL of the server under test. */
  target: string
  latency: SpeedtestLatencyStats
  download: SpeedtestThroughputStats
  upload: SpeedtestThroughputStats
  /** Absent when the probes are disabled (`loadedPingIntervalMs: 0`) or produced no samples. */
  loadedLatency?: undefined | SpeedtestLoadedLatency
  verdict: SpeedtestVerdict
}

/**
 * What was measured before a phase timed out: the completed phases plus whatever the
 * interrupted phase collected. No verdict — it would judge an incomplete measurement.
 */
export interface SpeedtestPartialResult {
  /** ISO 8601. */
  timestamp: string
  /** Base URL of the server under test. */
  target: string
  /** The phase whose safety timeout fired. */
  timedOutPhase: SpeedtestPhase
  latency?: undefined | SpeedtestLatencyStats
  download?: undefined | SpeedtestThroughputStats
  upload?: undefined | SpeedtestThroughputStats
  loadedLatency?: undefined | SpeedtestLoadedLatency
}

/** One received chunk, timestamped for the fixed-window throughput sampling. */
export interface SpeedtestTransferChunk {
  bytes: number
  atMs: number
}
