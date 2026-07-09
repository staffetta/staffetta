import {
  bytesToMbps,
  computeLatencyStats,
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
  type SpeedtestPaths,
  type SpeedtestPhase,
  type SpeedtestProgressSample,
  type SpeedtestResult,
  type SpeedtestThroughputStats,
  type SpeedtestTransferChunk,
  type SpeedtestUploadReply,
  type SpeedtestVerdictThresholds,
} from '@staffetta/core'

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
 * Runs the whole relay (ping → download → upload) and resolves with the measured result.
 * Rejects with the underlying error on failure, timeout (`TimeoutError`) or abort.
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

  options.onPhase?.('ping')
  const latency = await runPingPhase(context)

  options.onPhase?.('download')
  const download = await runDownloadPhase(context)

  options.onPhase?.('upload')
  const upload = await runUploadPhase(context)

  return {
    timestamp: new Date().toISOString(),
    target: context.baseUrl,
    latency,
    download,
    upload,
    verdict: computeVerdict({latency, download, upload}, {...SpeedtestDefaultThresholds, ...options.thresholds}),
  }
}

async function runPingPhase(context: SpeedtestContext): Promise<SpeedtestLatencyStats> {
  const {config, onSample} = context
  const signal = createPhaseSignal(context)

  // Warm-up request, not measured: keeps the initial TCP/TLS connection setup out of the samples.
  await requestPing(context, signal)

  const rttSamplesMs: Array<number> = []

  for (let idx = 0; idx < config.pingCount; ++idx) {
    const startedAt = performance.now()
    await requestPing(context, signal)
    const rttMs = performance.now() - startedAt

    rttSamplesMs.push(rttMs)
    onSample?.({phase: 'ping', seq: idx + 1, rttMs: roundTo(rttMs, 1)})
  }

  return computeLatencyStats(rttSamplesMs)
}

async function runDownloadPhase(context: SpeedtestContext): Promise<SpeedtestThroughputStats> {
  const {config, onSample} = context
  const signal = createPhaseSignal(context)

  const response = await request(context, 'GET', `${context.paths.download}?size=${config.transferSizeBytes}`, {
    signal,
  })
  assertResponseOk(response, 'download')

  const reader = response.body?.getReader()

  if (!reader) {
    throw new Error('speedtest download: missing response body stream')
  }

  // The clock starts after the response headers, so the samples measure payload transfer only.
  const startMs = performance.now()
  const chunks: Array<SpeedtestTransferChunk> = []
  let totalBytes = 0
  // Live-log window, display only: the final stats are recomputed from the chunk list.
  let windowStartMs = startMs
  let windowBytes = 0

  while (true) {
    const {done, value} = await reader.read() // Rejects on abort, releasing the stream.
    if (done) {
      break
    }

    const nowMs = performance.now()
    totalBytes += value.byteLength
    windowBytes += value.byteLength
    chunks.push({bytes: value.byteLength, atMs: nowMs})

    if (nowMs - windowStartMs >= config.sampleIntervalMs) {
      onSample?.({
        phase: 'download',
        mbps: roundTo(bytesToMbps(windowBytes, nowMs - windowStartMs), 2),
        transferredBytes: totalBytes,
        totalBytes: config.transferSizeBytes,
      })
      windowStartMs = nowMs
      windowBytes = 0
    }
  }

  const endMs = performance.now()
  const samplesMbps = computeThroughputSamplesMbps(chunks, {startMs, endMs, intervalMs: config.sampleIntervalMs})

  return computeThroughputStats(samplesMbps, bytesToMbps(totalBytes, endMs - startMs))
}

/**
 * Upload progress with fetch() is not observable (request-body streaming needs HTTP/2 plus
 * `duplex: 'half'`), so the payload is split into sequential POST chunks on the same keep-alive
 * connection: each chunk yields one throughput sample, enough for min/max/CV. The time base per
 * chunk is the server-measured receive time when available, which excludes the response round
 * trip; servers replying `serverElapsedMs: 0` degrade to the client clock.
 */
async function runUploadPhase(context: SpeedtestContext): Promise<SpeedtestThroughputStats> {
  const {config, onSample} = context
  const signal = createPhaseSignal(context)
  const chunkBytes = Math.max(1, Math.floor(config.transferSizeBytes / config.uploadChunkCount))
  // Zero-filled payload: random data would only waste CPU (the server discards the bytes anyway).
  const payload = new Blob([new Uint8Array(chunkBytes)], {type: 'application/octet-stream'})

  const samplesMbps: Array<number> = []
  let totalBytes = 0
  let totalElapsedMs = 0

  for (let idx = 0; idx < config.uploadChunkCount; ++idx) {
    const startedAt = performance.now()
    const reply = await requestUpload(context, payload, signal)
    const clientElapsedMs = performance.now() - startedAt
    const elapsedMs = reply.serverElapsedMs > 0 ? reply.serverElapsedMs : clientElapsedMs

    totalBytes += reply.bytesReceived
    totalElapsedMs += elapsedMs
    samplesMbps.push(bytesToMbps(reply.bytesReceived, elapsedMs))
    onSample?.({
      phase: 'upload',
      seq: idx + 1,
      mbps: roundTo(bytesToMbps(reply.bytesReceived, elapsedMs), 2),
      transferredBytes: totalBytes,
      totalBytes: chunkBytes * config.uploadChunkCount,
    })
  }

  return computeThroughputStats(samplesMbps, bytesToMbps(totalBytes, totalElapsedMs))
}

// Fragments ///////////////////////////////////////////////////////////////////

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

function createPhaseSignal(context: SpeedtestContext): AbortSignal {
  const timeoutSignal = AbortSignal.timeout(context.config.phaseTimeoutMs)
  return context.userSignal ? AbortSignal.any([context.userSignal, timeoutSignal]) : timeoutSignal
}

function assertResponseOk(response: Response, phase: SpeedtestPhase) {
  if (!response.ok) {
    throw new Error(`speedtest ${phase} request failed with HTTP ${response.status}`)
  }
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
