import assert from 'node:assert/strict'
import {describe, it} from 'node:test'
import {createSpeedtestFetchHandler} from '../src/index.ts'

const Base = 'http://test.local/speedtest'

describe('createSpeedtestFetchHandler', () => {
  it('replies pong on ping', async () => {
    const handler = createSpeedtestFetchHandler()
    const response = await handler(new Request(`${Base}/ping`))

    assert.equal(response.status, 200)
    assert.equal(response.headers.get('cache-control'), 'no-store')
    assert.deepEqual(await response.json(), {pong: true})
  })

  it('streams exactly `size` bytes on download', async () => {
    const handler = createSpeedtestFetchHandler()
    const response = await handler(new Request(`${Base}/download?size=100000`))

    assert.equal(response.status, 200)
    assert.equal(response.headers.get('content-type'), 'application/octet-stream')
    assert.equal(response.headers.get('content-length'), '100000')

    const body = await response.arrayBuffer()
    assert.equal(body.byteLength, 100_000)
  })

  it('rejects an invalid or excessive download size', async () => {
    const handler = createSpeedtestFetchHandler({maxSizeBytes: 1000})

    for (const size of ['0', '-1', '1.5', 'abc', '1001', '']) {
      const response = await handler(new Request(`${Base}/download?size=${size}`))
      assert.equal(response.status, 400, `size=${size}`)
    }
  })

  it('counts and discards the upload body', async () => {
    const handler = createSpeedtestFetchHandler()
    const payload = new Uint8Array(65_000)
    const response = await handler(
      new Request(`${Base}/upload`, {
        method: 'POST',
        headers: {'content-type': 'application/octet-stream'},
        body: payload,
      }),
    )

    assert.equal(response.status, 200)
    const reply = (await response.json()) as {bytesReceived: number; serverElapsedMs: number}
    assert.equal(reply.bytesReceived, 65_000)
    assert.equal(typeof reply.serverElapsedMs, 'number')
  })

  it('rejects an upload over the limit with 413', async () => {
    const handler = createSpeedtestFetchHandler({maxSizeBytes: 1000})
    const response = await handler(
      new Request(`${Base}/upload`, {
        method: 'POST',
        body: new Uint8Array(2000),
      }),
    )

    assert.equal(response.status, 413)
  })

  it('replies 404 outside the speedtest paths and 405 on wrong methods', async () => {
    const handler = createSpeedtestFetchHandler()

    assert.equal((await handler(new Request('http://test.local/other'))).status, 404)
    assert.equal((await handler(new Request(`${Base}/ping`, {method: 'POST', body: 'x'}))).status, 405)
    assert.equal((await handler(new Request(`${Base}/upload`))).status, 405)
  })

  it('gates download/upload through authorize, never ping', async () => {
    const phases: Array<string> = []
    const handler = createSpeedtestFetchHandler({
      authorize: (_request, phase) => {
        phases.push(phase)
        return false
      },
    })

    assert.equal((await handler(new Request(`${Base}/ping`))).status, 200)
    assert.equal((await handler(new Request(`${Base}/download?size=10`))).status, 401)
    assert.equal((await handler(new Request(`${Base}/upload`, {method: 'POST', body: 'x'}))).status, 401)
    assert.deepEqual(phases, ['download', 'upload'])
  })

  it('honors a custom base path', async () => {
    const handler = createSpeedtestFetchHandler({basePath: '/api/v2/net'})

    assert.equal((await handler(new Request('http://test.local/api/v2/net/ping'))).status, 200)
    assert.equal((await handler(new Request(`${Base}/ping`))).status, 404)
  })
})
