import {
  bytesToMbps,
  computeLatencyStats,
  computeLoadedLatency,
  computeThroughputSamplesMbps,
  computeThroughputStats,
  computeVerdict,
  decodeUploadReply,
  resolveWarmupWindowsCount,
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

/**
 * Overlap lead used to hide the per-request round trip: the next download request is
 * prefetched (and the next upload POST dispatched) about one idle RTT before the current one
 * ends, so the link never sits idle between requests. Clamped to keep a degenerate ping
 * measurement from scheduling the overlap nonsensically.
 */
const MinOverlapLeadMs = 10
const MaxOverlapLeadMs = 500

/**
 * Download requests are sized to outlast the remaining phase time by this factor: the deadline
 * abort trims them (the received bytes still count), which is cheaper than a finish-and-refetch
 * boundary near the deadline. Upload POSTs use no overshoot — they cannot be aborted without
 * losing their bytes, so they aim to complete right at the deadline.
 */
const DownloadSizeOvershootFactor = 1.25

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

    // The idle median RTT paces the request overlap of both transfer phases.
    const overlapLeadMs = Math.min(MaxOverlapLeadMs, Math.max(MinOverlapLeadMs, latency.p50Ms))

    options.onPhase?.('download')
    download = await runDownloadPhase(context, overlapLeadMs)

    options.onPhase?.('upload')
    upload = await runUploadPhase(context, overlapLeadMs)
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
 * sizes its request to carry the observed rate through the remaining phase time and prefetches
 * the next request one idle RTT before the current body drains, so the per-request round trip
 * never leaves the link idle (a gap would undercount the throughput and fabricate zero-rate
 * windows that inflate the stability CV). In-flight requests are aborted when the deadline
 * fires — the bytes received so far are already accounted. Concurrent latency probes measure
 * the RTT under load.
 */
async function runDownloadPhase(context: SpeedtestContext, overlapLeadMs: number): Promise<TransferPhaseOutcome> {
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

  const issueRequest = (sizeBytes: number): PrefetchedDownload => {
    const response = request(context, 'GET', `${context.paths.download}?size=${sizeBytes}`, {signal: requestSignal})
    response.catch(() => {}) // May reject (deadline abort) before it is awaited; the await still sees the rejection.
    return {sizeBytes, response}
  }

  /** Releases a prefetched request that will never be drained (deadline abort or stream error). */
  const discardRequest = (prefetched: undefined | PrefetchedDownload) => {
    prefetched?.response.then(response => response.body?.cancel()).catch(() => {})
  }

  const runStream = async () => {
    let prefetched: undefined | PrefetchedDownload = issueRequest(config.initialRequestSizeBytes)

    while (prefetched) {
      const current = prefetched
      prefetched = undefined

      try {
        const response = await current.response
        assertResponseOk(response, 'download')

        const reader = response.body?.getReader()

        if (!reader) {
          throw new Error('speedtest download: missing response body stream')
        }

        // Rate baseline from the first body byte, not the request dispatch: the connection
        // round trip would dilute the estimate that sizes and schedules the next request.
        const bodyStartMs = performance.now()
        let requestBytes = 0

        while (true) {
          const {done, value} = await reader.read() // Rejects on abort, releasing the stream.
          if (done) {
            break
          }

          const nowMs = performance.now()
          requestBytes += value.byteLength
          chunks.push({bytes: value.byteLength, atMs: nowMs})
          progress.add(value.byteLength, nowMs)

          if (!prefetched && nowMs < deadlineMs) {
            const rateBytesPerMs = requestBytes / Math.max(1, nowMs - bodyStartMs)

            if (current.sizeBytes - requestBytes <= rateBytesPerMs * overlapLeadMs) {
              prefetched = issueRequest(
                nextRequestSizeBytes({
                  rateBytesPerMs,
                  remainingMs: deadlineMs - nowMs,
                  overshootFactor: DownloadSizeOvershootFactor,
                  config,
                }),
              )
            }
          }
        }

        if (!prefetched && performance.now() < deadlineMs) {
          // Body ended before the prefetch armed (e.g. a shorter-than-requested response):
          // keep the stream going instead of ending the phase early.
          const rateBytesPerMs = requestBytes / Math.max(1, performance.now() - bodyStartMs)
          prefetched = issueRequest(
            nextRequestSizeBytes({
              rateBytesPerMs,
              remainingMs: deadlineMs - performance.now(),
              overshootFactor: DownloadSizeOvershootFactor,
              config,
            }),
          )
        }
      } catch (error) {
        discardRequest(prefetched)
        if (deadlineController.signal.aborted && !phase.signal.aborted) {
          return // Deadline hit mid-transfer: normal completion, the received bytes are counted.
        }
        throw error
      }
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
 * `duplex: 'half'`), so each stream sends POST chunks sized to carry the observed rate through
 * the remaining phase time. The POSTs are pipelined at depth 2: the next one is dispatched one
 * idle RTT before the current one is predicted to finish sending, so the reply round trip
 * overlaps the next send instead of idling the link. A stream stops dispatching once the
 * deadline passes (in-flight chunks complete: aborting them would lose their bytes). Each
 * completed POST is spread over the server-measured receive time (`serverElapsedMs`, which
 * excludes the request and response trips) anchored half an RTT before the reply landed, so
 * the windowed stats see the transfer where and as long as the server actually saw it.
 */
async function runUploadPhase(context: SpeedtestContext, overlapLeadMs: number): Promise<TransferPhaseOutcome> {
  const {config} = context
  const phase = createPhaseSignal(context)

  // Incompressible pool sliced per POST, filled before the phase clock starts: zeros (or any
  // pattern) would let transparent compression along the path inflate the measured upload —
  // the same reason the server streams random bytes on the download side.
  const payloadPool = createIncompressiblePayload(config.maxRequestSizeBytes)

  const sampler = startLoadedPingSampler(context, 'upload', phase.signal)

  const startMs = performance.now()
  const deadlineMs = startMs + config.transferDurationMs

  const chunks: Array<SpeedtestTransferChunk> = []
  const progress = createProgressWindow(context, 'upload', startMs)
  // Where the accounted transfer really ends (the last spread's edge, not its last piece).
  let spreadEndMaxMs = startMs

  const postChunk = (sizeBytes: number): PostedUpload => {
    const reply = requestUpload(context, payloadPool.slice(0, sizeBytes, 'application/octet-stream'), phase.signal)
    reply.catch(() => {}) // May reject (phase abort) before it is settled; settlePost still sees the rejection.
    return {sentAtMs: performance.now(), sizeBytes, reply}
  }

  /** Awaits the reply, accounts the transfer, and returns the observed rate in bytes/ms. */
  const settlePost = async (posted: PostedUpload): Promise<number> => {
    const reply = await posted.reply
    const nowMs = performance.now()
    const clientElapsedMs = nowMs - posted.sentAtMs
    // How long the POST occupied the link: the server-measured receive time, bounded on both
    // sides by the client clock — a server cannot have received longer than the whole round
    // trip, and one that drains its buffers in bursts can report a fraction of the real
    // transfer time (never less than the client-observed elapsed minus one round trip).
    const receiveElapsedMs = Math.max(
      1,
      Math.min(reply.serverElapsedMs, clientElapsedMs),
      clientElapsedMs - overlapLeadMs,
    )
    // The last byte reached the server about half a round trip before the reply landed here.
    const receiveEndMs = Math.max(posted.sentAtMs + receiveElapsedMs, nowMs - overlapLeadMs / 2)
    spreadEndMaxMs = Math.max(spreadEndMaxMs, receiveEndMs)

    chunks.push(
      ...spreadTransferChunks({
        bytes: reply.bytesReceived,
        endMs: receiveEndMs,
        elapsedMs: receiveElapsedMs,
        intervalMs: config.sampleIntervalMs,
        gridOriginMs: startMs,
      }),
    )
    progress.add(reply.bytesReceived, nowMs, bytesToMbps(reply.bytesReceived, receiveElapsedMs))

    return reply.bytesReceived / Math.max(1, receiveElapsedMs)
  }

  const runStream = async () => {
    // The first POST runs alone: its reply seeds the rate estimate that paces the pipeline.
    let rateBytesPerMs = await settlePost(postChunk(config.initialRequestSizeBytes))
    let previous: undefined | PostedUpload

    // Stop dispatching one lead short of the deadline: the in-flight POST is already sized
    // to reach it, and an extra POST would only overlap the tail and run past the phase.
    while (performance.now() < deadlineMs - overlapLeadMs) {
      const posted = postChunk(
        nextRequestSizeBytes({
          rateBytesPerMs,
          remainingMs: deadlineMs - performance.now(),
          overshootFactor: 1,
          config,
        }),
      )

      if (previous) {
        // Settling the previous reply overlaps `posted`'s send — and backpressures the
        // pipeline to depth 2 when the send-time prediction below runs short.
        rateBytesPerMs = await settlePost(previous)
      }
      previous = posted

      // Sleep until `posted` is predicted to be one lead short of fully sent, so the next
      // iteration dispatches while this POST's tail and reply are still in flight. Capped to
      // the deadline: past it the loop exits anyway (and a degenerate rate must not oversleep).
      const predictedSendEndMs = posted.sentAtMs + posted.sizeBytes / Math.max(rateBytesPerMs, 1e-6)
      const pacingMs = Math.min(deadlineMs, predictedSendEndMs - overlapLeadMs) - performance.now()
      await sleep(Math.max(0, pacingMs), phase.signal)
    }

    if (previous) {
      await settlePost(previous)
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

  // The measured transfer ends where the last spread ends: what follows is only the final
  // reply's round trip, and counting it would dilute the tail window and the average.
  const endMs = spreadEndMaxMs > startMs ? spreadEndMaxMs : performance.now()
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
 * Windowed stats over the received chunks. The warm-up excluded from the head is adaptive
 * (see {@link resolveWarmupWindowsCount}): the configured `warmupMs` is the floor, and it
 * extends until the throughput reaches steady state, so TCP slow start and the size ramp on
 * high-BDP links do not deflate the average or inflate the CV. The average is the
 * whole-transfer rate over the measured range.
 */
function computeTransferStats(
  chunks: Array<SpeedtestTransferChunk>,
  args: {startMs: number; endMs: number; config: SpeedtestConfig},
): SpeedtestThroughputStats {
  const {startMs, endMs, config} = args

  const allSamplesMbps = computeThroughputSamplesMbps(chunks, {
    startMs,
    endMs,
    intervalMs: config.sampleIntervalMs,
  })
  const warmupWindows = resolveWarmupWindowsCount(allSamplesMbps, Math.ceil(config.warmupMs / config.sampleIntervalMs))
  const statsStartMs = startMs + warmupWindows * config.sampleIntervalMs

  const measuredBytes = chunks.reduce((sum, chunk) => (chunk.atMs >= statsStartMs ? sum + chunk.bytes : sum), 0)

  return computeThroughputStats(allSamplesMbps.slice(warmupWindows), bytesToMbps(measuredBytes, endMs - statsStartMs))
}

/**
 * Next size of the adaptive ramp: enough bytes to carry the observed rate through the
 * remaining phase time (scaled by the caller's overshoot policy), clamped to the configured
 * bounds. Fewer, longer requests mean fewer request boundaries for the overlap to hide.
 */
function nextRequestSizeBytes(args: {
  rateBytesPerMs: number
  remainingMs: number
  overshootFactor: number
  config: SpeedtestConfig
}): number {
  const {rateBytesPerMs, remainingMs, overshootFactor, config} = args

  if (rateBytesPerMs <= 0 || remainingMs <= 0) {
    return config.initialRequestSizeBytes
  }

  const targetBytes = rateBytesPerMs * remainingMs * overshootFactor

  return Math.max(config.initialRequestSizeBytes, Math.min(config.maxRequestSizeBytes, Math.floor(targetBytes)))
}

/**
 * One `crypto.getRandomValues`-filled pool sliced per POST: allocating payloads inside the
 * timed loop would starve the throughput windows, and compressible content would let
 * transparent compression along the path inflate the measurement. The RNG caps at 64 KiB per
 * call, hence the segmented fill.
 */
function createIncompressiblePayload(sizeBytes: number): Blob {
  const bytes = new Uint8Array(sizeBytes)

  for (let offset = 0; offset < sizeBytes; offset += 65_536) {
    crypto.getRandomValues(bytes.subarray(offset, Math.min(sizeBytes, offset + 65_536)))
  }

  return new Blob([bytes], {type: 'application/octet-stream'})
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

/** A download request dispatched ahead of time, drained when the current one ends. */
interface PrefetchedDownload {
  sizeBytes: number
  response: Promise<Response>
}

/** An upload POST in flight: dispatched, possibly still sending, its reply not yet awaited. */
interface PostedUpload {
  sentAtMs: number
  sizeBytes: number
  reply: Promise<SpeedtestUploadReply>
}
