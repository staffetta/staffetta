import {
  bytesToMbps,
  computeLatencyStats,
  computeLoadedLatency,
  computeThroughputSamplesMbps,
  computeThroughputStats,
  computeVerdict,
  decodeUploadReply,
  roundTo,
  type SpeedtestConfig,
  SpeedtestDefaultConfig,
  SpeedtestDefaultPaths,
  SpeedtestDefaultThresholds,
  type SpeedtestLatencyStats,
  type SpeedtestPartialResult,
  type SpeedtestPaths,
  type SpeedtestPhase,
  type SpeedtestProgressSample,
  type SpeedtestResult,
  type SpeedtestThroughputStats,
  type SpeedtestTransferChunk,
  type SpeedtestUploadReply,
  type SpeedtestVerdictThresholds,
  spreadTransferChunks,
} from '@staffetta/core'

/** Size each ramped request so it lasts roughly this long at the currently observed rate. */
const TargetRequestDurationMs = 1000

export interface SpeedtestClientOptions {
  /** Base URL of the server under test, e.g. `https://api.example.com`. */
  baseUrl: string
  /** Endpoint paths appended to `baseUrl`. Default: `/speedtest/{ping,download,upload}`. */
  paths?: undefined | Partial<SpeedtestPaths>
  /** Extra request headers (e.g. authorization), static or resolved before each request. */
  headers?: undefined | HeadersInit | (() => HeadersInit | Promise<HeadersInit>)
  /** Custom fetch implementation (interceptors, environments without a global fetch). */
  fetch?: undefined | typeof fetch
  /** Cancels the whole test when aborted. */
  signal?: undefined | AbortSignal
  config?: undefined | Partial<SpeedtestConfig>
  /** Verdict tuning; merged over {@link SpeedtestDefaultThresholds}. */
  thresholds?: undefined | Partial<SpeedtestVerdictThresholds>
  onPhase?: undefined | ((phase: SpeedtestPhase) => void)
  onSample?: undefined | ((sample: SpeedtestProgressSample) => void)
}

/**
 * A phase safety timeout fired: the test is over, but `partial` carries the completed phases
 * plus whatever the interrupted phase measured before stalling — enough to see, for example,
 * that ping and download were fine and the upload is what hangs.
 */
export class SpeedtestTimeoutError extends Error {
  override readonly name = 'SpeedtestTimeoutError'
  readonly partial: SpeedtestPartialResult

  constructor(partial: SpeedtestPartialResult) {
    super(`speedtest ${partial.timedOutPhase} phase timed out`)
    this.partial = partial
  }
}

interface SpeedtestPhaseSalvage {
  latency?: undefined | SpeedtestLatencyStats
  throughput?: undefined | SpeedtestThroughputStats
  loadedRttSamplesMs?: undefined | Array<number>
}

/** Internal marker thrown by a phase when its safety timeout fires, carrying the salvage. */
class SpeedtestPhaseTimeout {
  readonly phase: SpeedtestPhase
  readonly salvage: SpeedtestPhaseSalvage

  constructor(phase: SpeedtestPhase, salvage: SpeedtestPhaseSalvage) {
    this.phase = phase
    this.salvage = salvage
  }
}

/**
 * Runs the whole relay (ping → download → upload) and resolves with the measured result.
 * Rejects with {@link SpeedtestTimeoutError} (carrying the partial result) on a phase timeout,
 * or with the underlying error on failure or abort.
 */
export async function runSpeedtest(options: SpeedtestClientOptions): Promise<SpeedtestResult> {
  const context: SpeedtestContext = {
    baseUrl: options.baseUrl.endsWith('/') ? options.baseUrl.slice(0, -1) : options.baseUrl,
    paths: {...SpeedtestDefaultPaths, ...options.paths},
    headers: options.headers,
    fetch: options.fetch ?? ((...args) => fetch(...args)),
    userSignal: options.signal,
    config: {...SpeedtestDefaultConfig, ...options.config},
    onSample: options.onSample,
  }

  let latency: undefined | SpeedtestLatencyStats
  let download: undefined | TransferPhaseOutcome
  let upload: undefined | TransferPhaseOutcome

  try {
    options.onPhase?.('ping')
    latency = await runPingPhase(context)

    options.onPhase?.('download')
    download = await runDownloadPhase(context)

    options.onPhase?.('upload')
    upload = await runUploadPhase(context)
  } catch (error) {
    if (error instanceof SpeedtestPhaseTimeout) {
      throw new SpeedtestTimeoutError(assemblePartialResult(context, error, {latency, download}))
    }
    throw error
  }

  const loadedLatency = computeLoadedLatency(latency, download.loadedRttSamplesMs, upload.loadedRttSamplesMs)

  return {
    timestamp: new Date().toISOString(),
    target: context.baseUrl,
    latency,
    download: download.throughput,
    upload: upload.throughput,
    loadedLatency,
    verdict: computeVerdict(
      {latency, download: download.throughput, upload: upload.throughput, loadedLatency},
      {...SpeedtestDefaultThresholds, ...options.thresholds},
    ),
  }
}

async function runPingPhase(context: SpeedtestContext): Promise<SpeedtestLatencyStats> {
  const {config, onSample} = context
  const phase = createPhaseSignal(context)
  const rttSamplesMs: Array<number> = []

  try {
    // Warm-up request, not measured: keeps the initial TCP/TLS connection setup out of the samples.
    await requestPing(context, phase.signal)

    for (let idx = 0; idx < config.pingCount; ++idx) {
      const startedAt = performance.now()
      await requestPing(context, phase.signal)
      const rttMs = performance.now() - startedAt

      rttSamplesMs.push(rttMs)
      onSample?.({phase: 'ping', seq: idx + 1, rttMs: roundTo(rttMs, 1)})
    }
  } catch (error) {
    if (phase.timedOut()) {
      throw new SpeedtestPhaseTimeout('ping', {
        latency: rttSamplesMs.length > 0 ? computeLatencyStats(rttSamplesMs) : undefined,
      })
    }
    throw error
  }

  return computeLatencyStats(rttSamplesMs)
}

/**
 * Saturates the link for `transferDurationMs` with `connections` parallel streams. Each stream
 * requests back to back, ramping the request size to the observed rate (~1 s per request), and
 * the in-flight requests are aborted when the deadline fires — the bytes received so far are
 * already accounted. Concurrent latency probes measure the RTT under load.
 */
async function runDownloadPhase(context: SpeedtestContext): Promise<TransferPhaseOutcome> {
  const {config} = context
  const phase = createPhaseSignal(context)
  // Separate deadline controller: hitting the deadline is the normal end of the phase, not an error.
  const deadlineController = new AbortController()
  const requestSignal = AbortSignal.any([phase.signal, deadlineController.signal])
  const sampler = startLoadedPingSampler(context, 'download', phase.signal)

  const startMs = performance.now()
  const deadlineMs = startMs + config.transferDurationMs
  const deadlineTimer = setTimeout(() => deadlineController.abort(), config.transferDurationMs)

  const chunks: Array<SpeedtestTransferChunk> = []
  const progress = createProgressWindow(context, 'download', startMs)

  const runStream = async () => {
    let requestSizeBytes = config.initialRequestSizeBytes
    let streamBytes = 0
    const streamStartMs = performance.now()

    while (performance.now() < deadlineMs) {
      try {
        const response = await request(context, 'GET', `${context.paths.download}?size=${requestSizeBytes}`, {
          signal: requestSignal,
        })
        assertResponseOk(response, 'download')

        const reader = response.body?.getReader()

        if (!reader) {
          throw new Error('speedtest download: missing response body stream')
        }

        while (true) {
          const {done, value} = await reader.read() // Rejects on abort, releasing the stream.
          if (done) {
            break
          }

          const nowMs = performance.now()
          streamBytes += value.byteLength
          chunks.push({bytes: value.byteLength, atMs: nowMs})
          progress.add(value.byteLength, nowMs)
        }
      } catch (error) {
        if (deadlineController.signal.aborted && !phase.signal.aborted) {
          break // Deadline hit mid-transfer: normal completion, the received bytes are counted.
        }
        throw error
      }

      requestSizeBytes = nextRequestSizeBytes({
        transferredBytes: streamBytes,
        elapsedMs: performance.now() - streamStartMs,
        remainingMs: deadlineMs - performance.now(),
        config,
      })
    }
  }

  try {
    await Promise.all(Array.from({length: Math.max(1, config.connections)}, runStream))
  } catch (error) {
    if (phase.timedOut()) {
      throw new SpeedtestPhaseTimeout(
        'download',
        await salvageTransferPhase({chunks, sampler, startMs, deadlineMs, context}),
      )
    }
    throw error
  } finally {
    clearTimeout(deadlineTimer)
  }

  const endMs = performance.now()
  const loadedRttSamplesMs = await sampler.stop()

  return {
    throughput: computeTransferStats(chunks, {startMs, endMs, config}),
    loadedRttSamplesMs,
  }
}

/**
 * Upload progress with fetch() is not observable (request-body streaming needs HTTP/2 plus
 * `duplex: 'half'`), so each stream sends sequential POST chunks on its keep-alive connection,
 * ramping the chunk size like the download does. A stream stops starting new chunks once the
 * deadline passes (in-flight chunks complete: aborting them would lose their bytes), and the
 * size ramp is capped to the remaining time so the tail stays short. Each completed POST is
 * spread over its duration for the windowed stats; its displayed throughput prefers the
 * server-measured receive time (`serverElapsedMs`), which excludes the response round trip.
 */
async function runUploadPhase(context: SpeedtestContext): Promise<TransferPhaseOutcome> {
  const {config} = context
  const phase = createPhaseSignal(context)
  const sampler = startLoadedPingSampler(context, 'upload', phase.signal)

  const startMs = performance.now()
  const deadlineMs = startMs + config.transferDurationMs

  const chunks: Array<SpeedtestTransferChunk> = []
  const progress = createProgressWindow(context, 'upload', startMs)
  // One zero-filled pool sliced per POST: allocating (and zeroing) payloads inside the timed
  // loop would starve the throughput windows. Random data would only waste CPU anyway — the
  // server discards the bytes.
  const payloadPool = new Blob([new Uint8Array(config.maxRequestSizeBytes)], {type: 'application/octet-stream'})

  const runStream = async () => {
    let chunkSizeBytes = config.initialRequestSizeBytes

    while (performance.now() < deadlineMs) {
      const payload = payloadPool.slice(0, chunkSizeBytes, 'application/octet-stream')

      const sentAt = performance.now()
      const reply = await requestUpload(context, payload, phase.signal)
      const nowMs = performance.now()
      const clientElapsedMs = nowMs - sentAt
      const elapsedMs = reply.serverElapsedMs > 0 ? reply.serverElapsedMs : clientElapsedMs

      chunks.push(
        ...spreadTransferChunks({
          bytes: reply.bytesReceived,
          endMs: nowMs,
          elapsedMs: clientElapsedMs,
          intervalMs: config.sampleIntervalMs,
        }),
      )
      progress.add(reply.bytesReceived, nowMs, bytesToMbps(reply.bytesReceived, elapsedMs))

      chunkSizeBytes = nextRequestSizeBytes({
        transferredBytes: reply.bytesReceived,
        elapsedMs: clientElapsedMs,
        remainingMs: deadlineMs - performance.now(),
        config,
      })
    }
  }

  try {
    await Promise.all(Array.from({length: Math.max(1, config.connections)}, runStream))
  } catch (error) {
    if (phase.timedOut()) {
      throw new SpeedtestPhaseTimeout(
        'upload',
        await salvageTransferPhase({chunks, sampler, startMs, deadlineMs, context}),
      )
    }
    throw error
  }

  const endMs = performance.now()
  const loadedRttSamplesMs = await sampler.stop()

  return {
    throughput: computeTransferStats(chunks, {startMs, endMs, config}),
    loadedRttSamplesMs,
  }
}

// Fragments ///////////////////////////////////////////////////////////////////

/**
 * What a timed-out transfer phase still knows: throughput stats over the chunks received up to
 * the phase deadline (the stalled tail past it would only dilute them) and the loaded-latency
 * probes collected so far.
 */
async function salvageTransferPhase(args: {
  chunks: Array<SpeedtestTransferChunk>
  sampler: {stop: () => Promise<Array<number>>}
  startMs: number
  deadlineMs: number
  context: SpeedtestContext
}): Promise<{throughput: undefined | SpeedtestThroughputStats; loadedRttSamplesMs: Array<number>}> {
  const {chunks, sampler, startMs, deadlineMs, context} = args
  const endMs = Math.min(performance.now(), deadlineMs)
  const loadedRttSamplesMs = await sampler.stop()

  return {
    throughput: chunks.length > 0 ? computeTransferStats(chunks, {startMs, endMs, config: context.config}) : undefined,
    loadedRttSamplesMs,
  }
}

/** Builds the partial result from the completed phases plus the interrupted phase's salvage. */
function assemblePartialResult(
  context: SpeedtestContext,
  timeout: SpeedtestPhaseTimeout,
  completed: {latency: undefined | SpeedtestLatencyStats; download: undefined | TransferPhaseOutcome},
): SpeedtestPartialResult {
  const latency = completed.latency ?? timeout.salvage.latency
  const downloadLoadedRtts =
    completed.download?.loadedRttSamplesMs ??
    (timeout.phase === 'download' ? (timeout.salvage.loadedRttSamplesMs ?? []) : [])
  const uploadLoadedRtts = timeout.phase === 'upload' ? (timeout.salvage.loadedRttSamplesMs ?? []) : []

  return {
    timestamp: new Date().toISOString(),
    target: context.baseUrl,
    timedOutPhase: timeout.phase,
    latency,
    download: completed.download?.throughput ?? (timeout.phase === 'download' ? timeout.salvage.throughput : undefined),
    upload: timeout.phase === 'upload' ? timeout.salvage.throughput : undefined,
    loadedLatency: latency && computeLoadedLatency(latency, downloadLoadedRtts, uploadLoadedRtts),
  }
}

/**
 * Windowed stats over the received chunks, skipping the configured warm-up (TCP slow start and
 * the size ramp would deflate min and inflate the CV). Phases shorter than the warm-up fall
 * back to the full range. The average is the whole-transfer rate over the measured range.
 */
function computeTransferStats(
  chunks: Array<SpeedtestTransferChunk>,
  args: {startMs: number; endMs: number; config: SpeedtestConfig},
): SpeedtestThroughputStats {
  const {startMs, endMs, config} = args
  const warmupEndMs = startMs + config.warmupMs
  const statsStartMs = warmupEndMs < endMs ? warmupEndMs : startMs

  const measuredChunks = chunks.filter(chunk => chunk.atMs >= statsStartMs)
  const measuredBytes = measuredChunks.reduce((sum, chunk) => sum + chunk.bytes, 0)
  const samplesMbps = computeThroughputSamplesMbps(measuredChunks, {
    startMs: statsStartMs,
    endMs,
    intervalMs: config.sampleIntervalMs,
  })

  return computeThroughputStats(samplesMbps, bytesToMbps(measuredBytes, endMs - statsStartMs))
}

/**
 * Next size of the adaptive ramp: aim at {@link TargetRequestDurationMs} at the observed rate,
 * capped to what the remaining time can carry (so the last request does not run long past the
 * deadline) and clamped to the configured bounds.
 */
function nextRequestSizeBytes(args: {
  transferredBytes: number
  elapsedMs: number
  remainingMs: number
  config: SpeedtestConfig
}): number {
  const {transferredBytes, elapsedMs, remainingMs, config} = args
  const rateBytesPerMs = elapsedMs > 0 ? transferredBytes / elapsedMs : 0

  if (rateBytesPerMs <= 0) {
    return config.initialRequestSizeBytes
  }

  const targetBytes = rateBytesPerMs * TargetRequestDurationMs
  const remainingCapBytes = remainingMs > 0 ? rateBytesPerMs * remainingMs : targetBytes

  return Math.max(
    config.initialRequestSizeBytes,
    Math.min(config.maxRequestSizeBytes, Math.floor(Math.min(targetBytes, remainingCapBytes))),
  )
}

/**
 * Concurrent RTT probes against the ping endpoint while a transfer phase runs, feeding the
 * loaded-latency (bufferbloat) measure. Probe failures end the sampling quietly (the transfer
 * itself is the phase's authority on errors); the samples collected so far are kept.
 */
function startLoadedPingSampler(
  context: SpeedtestContext,
  phase: 'download' | 'upload',
  signal: AbortSignal,
): {stop: () => Promise<Array<number>>} {
  const {config, onSample} = context
  const rttSamplesMs: Array<number> = []
  let running = config.loadedPingIntervalMs > 0

  const loop = (async () => {
    while (running && !signal.aborted) {
      const startedAt = performance.now()
      try {
        await requestPing(context, signal)
      } catch {
        return
      }
      const rttMs = performance.now() - startedAt

      rttSamplesMs.push(rttMs)
      onSample?.({phase, kind: 'loaded-ping', rttMs: roundTo(rttMs, 1)})
      await sleep(config.loadedPingIntervalMs, signal)
    }
  })()

  return {
    stop: async () => {
      running = false
      await loop
      return rttSamplesMs
    },
  }
}

/** Shared live-log window across the parallel streams, display only: stats are recomputed later. */
function createProgressWindow(context: SpeedtestContext, phase: 'download' | 'upload', startMs: number) {
  const {config, onSample} = context
  let windowStartMs = startMs
  let windowBytes = 0
  let totalBytes = 0

  return {
    /** `mbps` overrides the window rate for event-sized transfers (one upload POST = one event). */
    add(bytes: number, nowMs: number, mbps?: undefined | number) {
      totalBytes += bytes
      windowBytes += bytes

      if (mbps !== undefined || nowMs - windowStartMs >= config.sampleIntervalMs) {
        onSample?.({
          phase,
          kind: 'throughput',
          mbps: roundTo(mbps ?? bytesToMbps(windowBytes, nowMs - windowStartMs), 2),
          transferredBytes: totalBytes,
          elapsedMs: Math.round(nowMs - startMs),
        })
        windowStartMs = nowMs
        windowBytes = 0
      }
    },
  }
}

async function requestPing(context: SpeedtestContext, signal: AbortSignal): Promise<void> {
  const response = await request(context, 'GET', context.paths.ping, {signal})
  assertResponseOk(response, 'ping')
  await response.arrayBuffer() // Consumes the tiny body so the RTT covers the whole response.
}

async function requestUpload(
  context: SpeedtestContext,
  payload: Blob,
  signal: AbortSignal,
): Promise<SpeedtestUploadReply> {
  const response = await request(context, 'POST', context.paths.upload, {
    signal,
    body: payload,
    contentType: 'application/octet-stream',
  })
  assertResponseOk(response, 'upload')

  return decodeUploadReply(await response.json())
}

async function request(
  context: SpeedtestContext,
  method: 'GET' | 'POST',
  pathAndQuery: string,
  args: {signal: AbortSignal; body?: undefined | Blob; contentType?: undefined | string},
): Promise<Response> {
  const headers = new Headers(typeof context.headers === 'function' ? await context.headers() : context.headers)

  if (args.contentType) {
    headers.set('content-type', args.contentType)
  }

  return context.fetch(`${context.baseUrl}${pathAndQuery}`, {
    method,
    headers,
    body: args.body ?? null,
    cache: 'no-store',
    signal: args.signal,
  })
}

function createPhaseSignal(context: SpeedtestContext): {signal: AbortSignal; timedOut: () => boolean} {
  const timeoutSignal = AbortSignal.timeout(context.config.phaseTimeoutMs)

  return {
    signal: context.userSignal ? AbortSignal.any([context.userSignal, timeoutSignal]) : timeoutSignal,
    // A user abort racing the timeout stays an abort: only the timeout signal marks a timeout.
    timedOut: () => timeoutSignal.aborted && !context.userSignal?.aborted,
  }
}

function assertResponseOk(response: Response, phase: SpeedtestPhase) {
  if (!response.ok) {
    throw new Error(`speedtest ${phase} request failed with HTTP ${response.status}`)
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    const onAbort = () => {
      clearTimeout(timer)
      resolve()
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal.addEventListener('abort', onAbort, {once: true})
  })
}

// Types ///////////////////////////////////////////////////////////////////////

interface SpeedtestContext {
  baseUrl: string
  paths: SpeedtestPaths
  headers: SpeedtestClientOptions['headers']
  fetch: typeof fetch
  userSignal: undefined | AbortSignal
  config: SpeedtestConfig
  onSample: undefined | ((sample: SpeedtestProgressSample) => void)
}

interface TransferPhaseOutcome {
  throughput: SpeedtestThroughputStats
  loadedRttSamplesMs: Array<number>
}
