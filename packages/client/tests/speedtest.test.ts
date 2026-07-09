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
    let uploadSamples = 0

    const result = await runSpeedtest({
      baseUrl,
      config: {
        pingCount: 3,
        transferSizeBytes: 512 * 1024,
        uploadChunkCount: 2,
        sampleIntervalMs: 20,
        phaseTimeoutMs: 30_000,
      },
      onPhase: phase => phases.push(phase),
      onSample: sample => {
        if (sample.phase === 'ping') pingSamples += 1
        if (sample.phase === 'upload') uploadSamples += 1
      },
    })

    assert.deepEqual(phases, ['ping', 'download', 'upload'])
    assert.equal(pingSamples, 3)
    assert.equal(uploadSamples, 2)

    assert.ok(result.latency.avgMs >= 0)
    assert.ok(result.latency.minMs <= result.latency.maxMs)
    assert.ok(result.download.avgMbps > 0)
    assert.ok(result.upload.avgMbps > 0)
    assert.equal(result.target, baseUrl)
    assert.ok(['optimal', 'good', 'unstable', 'critical'].includes(result.verdict))
  })

  it('resolves custom headers before each request', async () => {
    let resolved = 0

    await runSpeedtest({
      baseUrl,
      headers: () => {
        resolved += 1
        return {authorization: 'Bearer test'}
      },
      config: {pingCount: 1, transferSizeBytes: 1024, uploadChunkCount: 1, phaseTimeoutMs: 30_000},
    })

    // Warm-up + 1 ping + 1 download + 1 upload.
    assert.equal(resolved, 4)
  })

  it('rejects with an abort error when the signal fires', async () => {
    const abortController = new AbortController()
    const pending = runSpeedtest({
      baseUrl,
      signal: abortController.signal,
      config: {pingCount: 50, transferSizeBytes: 1024, phaseTimeoutMs: 30_000},
    })

    abortController.abort()

    await assert.rejects(pending)
  })

  it('rejects when the server replies an error status', async () => {
    await assert.rejects(
      runSpeedtest({
        baseUrl,
        paths: {ping: '/nowhere'},
        config: {pingCount: 1, transferSizeBytes: 1024, phaseTimeoutMs: 5000},
      }),
      /speedtest ping request failed with HTTP 404/,
    )
  })
})
