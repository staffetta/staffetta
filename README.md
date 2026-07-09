<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/brand/lockup-dark.svg">
    <img src="docs/brand/lockup.svg" alt="staffetta" width="380">
  </picture>
</p>

*Staffetta* is Italian for relay race — because a speedtest is exactly that: three legs run in
sequence (**ping → download → upload**), where the baton is the bytes passed between your client
and **your own server**. No third-party measurement servers: you mount three endpoints on your
backend and measure the path your users actually use.

- **Framework-free client** — plain `fetch`, runs in browsers and Node.
- **Framework-agnostic server** — a Web-standard `(Request) => Response` handler that mounts
  natively on Hono, Next.js, Bun, Deno, Cloudflare Workers, SvelteKit… plus a Node `http`
  adapter for Express and friends. Or skip both and use the raw stream primitives.
- **An open protocol** — three documented HTTP endpoints; implement them in any language.
- **Real statistics** — average, min/max, jitter (RTT std dev), stability (throughput
  coefficient of variation), and an explainable verdict with configurable thresholds.

## Packages

| Package | What it is |
| --- | --- |
| `@staffetta/core` | Protocol types, wire contract, measurement math. Zero dependencies, isomorphic. |
| `@staffetta/client` | The test engine: `runSpeedtest()`. |
| `@staffetta/server` | Fetch handler, Node adapter (`/node`), stream primitives. |
| `@staffetta/react` | `useSpeedtest()` hook over the client. |

## Server

### Fetch-based runtimes (Hono, Next.js, Bun, Deno, Workers…)

```ts
import {createSpeedtestFetchHandler} from '@staffetta/server'

const speedtest = createSpeedtestFetchHandler()

// Hono
app.all('/speedtest/*', c => speedtest(c.req.raw))

// Next.js — app/speedtest/[[...slug]]/route.ts
export const GET = speedtest
export const POST = speedtest
```

### Node http / Express

```ts
import {createServer} from 'node:http'
import {createSpeedtestNodeListener} from '@staffetta/server/node'

createServer(createSpeedtestNodeListener()).listen(8080)

// Express
app.use(createSpeedtestNodeListener())
```

### Options

```ts
createSpeedtestFetchHandler({
  basePath: '/speedtest',        // path prefix of the three endpoints
  maxSizeBytes: 209_715_200,     // per-transfer cap (200 MiB)
  authorize: (request, phase) => checkToken(request), // download/upload only; ping stays anonymous
})
```

`authorize` never runs for ping — the ping endpoint is anonymous **by design**, so the client
measures pure network RTT instead of auth + session time. For anything stronger, wrap the
handler with your own middleware.

### Raw primitives

If you'd rather wire the endpoints into your own controllers (NestJS, Fastify, anything):

```ts
import {createDownloadStream, consumeUploadStream} from '@staffetta/server'

createDownloadStream(sizeBytes)                    // ReadableStream of incompressible bytes
await consumeUploadStream(body, {maxBytes})        // → {bytesReceived, serverElapsedMs}
```

## Client

```ts
import {runSpeedtest} from '@staffetta/client'

const result = await runSpeedtest({
  baseUrl: 'https://api.example.com',
  headers: () => ({authorization: `Bearer ${getToken()}`}), // resolved before each request
  signal: abortController.signal,
  onPhase: phase => console.log(`— ${phase}`),
  onSample: sample => console.log(sample),
})

// result: {timestamp, target, latency: {avgMs, minMs, maxMs, jitterMs},
//          download: {avgMbps, minMbps, maxMbps, stabilityCv}, upload: {…},
//          verdict: 'optimal' | 'good' | 'unstable' | 'critical'}
```

Tune the run with `config` (ping count, transfer size, upload chunks, sample window, phase
timeout) and the verdict with `thresholds`; defaults live in `@staffetta/core`.

## React

```tsx
import {useSpeedtest} from '@staffetta/react'

function SpeedtestPanel() {
  const {status, log, start, cancel} = useSpeedtest({baseUrl: 'https://api.example.com'})

  return (
    <div>
      {status.kind === 'idle' && <button onClick={start}>Run speedtest</button>}
      {status.kind === 'running' && <button onClick={cancel}>Cancel ({status.phase}…)</button>}
      {status.kind === 'done' && <pre>{JSON.stringify(status.result, null, 2)}</pre>}
      {status.kind === 'error' && <p>Test failed: {status.reason}</p>}
      <ul>{log.map((entry, idx) => <li key={idx}>{JSON.stringify(entry)}</li>)}</ul>
    </div>
  )
}
```

## The protocol

Any server that speaks these three endpoints can be measured by the client — the reference
implementation is `@staffetta/server`, but a Go or Python one works the same. All responses
carry `cache-control: no-store`.

| Endpoint | Behaviour |
| --- | --- |
| `GET {base}/ping` | Reply immediately with minimal JSON: `{"pong": true}`. The client measures the full round trip (a warm-up request is sent first and discarded, keeping TCP/TLS setup out of the samples). |
| `GET {base}/download?size=N` | Stream exactly `N` bytes of **incompressible** data as `application/octet-stream` with an explicit `content-length`. Incompressible, or transparent compression on the path inflates the measurement. Reply `400` for a non-integer, non-positive or over-limit `size`. |
| `POST {base}/upload` | Count and discard the raw `application/octet-stream` body, reply `{"bytesReceived": n, "serverElapsedMs": n}` and `413` over the limit. |

`serverElapsedMs` is the server-side first-to-last-byte receive time. The client prefers it as
the upload time base because it excludes the response round trip; servers that cannot measure
it reply `0` and the client falls back to its own clock.

**Why chunked uploads?** Upload progress is not observable with `fetch()` (request-body
streaming needs HTTP/2 plus `duplex: 'half'`), so the client sends the payload as sequential
POSTs on the same keep-alive connection — each chunk yields one throughput sample, enough for
min/max and the stability CV.

## Development

```sh
pnpm install
pnpm build
pnpm test
```

## License

[MIT](./LICENSE)
