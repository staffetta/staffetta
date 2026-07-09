import assert from 'node:assert/strict'
import {createServer, type Server} from 'node:http'
import {after, before, describe, it} from 'node:test'
import {createSpeedtestNodeListener} from '@staffetta/server/node'
import {runSpeedtest} from '../src/index.ts'

// End-to-end: the real client engine against the real Node adapter over a loopback socket.
describe('runSpeedtest', () => {
  let server: Server
  let baseUrl: string

  before(async () => {
    server = createServer(createSpeedtestNodeListener())
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))

    const address = server.address()
    assert.ok(address && typeof address === 'object')
    baseUrl = `http://127.0.0.1:${address.port}`
  })

  after(() => new Promise<void>((resolve, reject) => server.close(error => (error ? reject(error) : resolve()))))

  it('runs the whole relay and reports a coherent result', async () => {
    const phases: Array<string> = []
    let pingSamples = 0
    let downloadThroughputSamples = 0
    let uploadThroughputSamples = 0
    let loadedPingSamples = 0

    const result = await runSpeedtest({
      baseUrl,
      config: {
        pingCount: 3,
        transferDurationMs: 400,
        warmupMs: 50,
        initialRequestSizeBytes: 64 * 1024,
        maxRequestSizeBytes: 4 * 1024 * 1024,
        connections: 2,
        loadedPingIntervalMs: 25,
        sampleIntervalMs: 20,
        phaseTimeoutMs: 30_000,
      },
      onPhase: phase => phases.push(phase),
      onSample: sample => {
        if (sample.phase === 'ping') pingSamples += 1
        else if (sample.kind === 'loaded-ping') loadedPingSamples += 1
        else if (sample.phase === 'download') downloadThroughputSamples += 1
        else uploadThroughputSamples += 1
      },
    })

    assert.deepEqual(phases, ['ping', 'download', 'upload'])
    assert.equal(pingSamples, 3)
    assert.ok(downloadThroughputSamples > 0)
    assert.ok(uploadThroughputSamples > 0)
    assert.ok(loadedPingSamples > 0)

    assert.ok(result.latency.avgMs >= 0)
    assert.ok(result.latency.minMs <= result.latency.p50Ms)
    assert.ok(result.latency.p50Ms <= result.latency.p90Ms)
    assert.ok(result.latency.p90Ms <= result.latency.maxMs)
    assert.ok(result.download.avgMbps > 0)
    assert.ok(result.upload.avgMbps > 0)
    assert.ok(result.loadedLatency)
    assert.ok(result.loadedLatency.bufferbloatMs >= 0)
    assert.ok(result.loadedLatency.download.avgMs > 0)
    assert.ok(result.loadedLatency.upload.avgMs > 0)
    assert.equal(result.target, baseUrl)
    assert.ok(['optimal', 'good', 'unstable', 'critical'].includes(result.verdict))
  })

  it('omits the loaded latency when the probes are disabled', async () => {
    const result = await runSpeedtest({
      baseUrl,
      config: {
        pingCount: 1,
        transferDurationMs: 100,
        warmupMs: 0,
        initialRequestSizeBytes: 16 * 1024,
        connections: 1,
        loadedPingIntervalMs: 0,
        phaseTimeoutMs: 30_000,
      },
    })

    assert.equal(result.loadedLatency, undefined)
  })

  it('resolves custom headers before each request', async () => {
    let resolved = 0

    await runSpeedtest({
      baseUrl,
      headers: () => {
        resolved += 1
        return {authorization: 'Bearer test'}
      },
      config: {
        pingCount: 1,
        transferDurationMs: 50,
        warmupMs: 0,
        initialRequestSizeBytes: 16 * 1024,
        connections: 1,
        loadedPingIntervalMs: 0,
        phaseTimeoutMs: 30_000,
      },
    })

    // At least warm-up + 1 ping + 1 download + 1 upload; the duration-based
    // transfer phases issue as many requests as fit in the window.
    assert.ok(resolved >= 4)
  })

  it('rejects with an abort error when the signal fires', async () => {
    const abortController = new AbortController()
    const pending = runSpeedtest({
      baseUrl,
      signal: abortController.signal,
      config: {pingCount: 50, transferDurationMs: 100, phaseTimeoutMs: 30_000},
    })

    abortController.abort()

    await assert.rejects(pending)
  })

  it('rejects when the server replies an error status', async () => {
    await assert.rejects(
      runSpeedtest({
        baseUrl,
        paths: {ping: '/nowhere'},
        config: {pingCount: 1, transferDurationMs: 100, phaseTimeoutMs: 5000},
      }),
      /speedtest ping request failed with HTTP 404/,
    )
  })
})
