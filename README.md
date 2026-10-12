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

**[Try the live demo →](https://staffetta.net/)** — the client running against a
Cloudflare Worker, with the raw sample log open.

- **Framework-free client** — plain `fetch`, runs in browsers and Node.
- **Framework-agnostic server** — a Web-standard `(Request) => Response` handler that mounts
  natively on Hono, Next.js, Bun, Deno, Cloudflare Workers, SvelteKit… plus a Node `http`
  adapter for Express and friends. Or skip both and use the raw stream primitives.
- **An open protocol** — three documented HTTP endpoints; implement them in any language.
- **Real statistics** — average, min/max, p50/p90 percentiles, jitter (mean difference between
  consecutive RTTs), stability (trimmed coefficient of variation of the throughput windows),
  latency under load (bufferbloat), and an explainable verdict with configurable thresholds and
  the reasons behind it.
- **A modern methodology** — parallel connections saturate high-bandwidth links, each transfer
  phase runs for a target duration with adaptively ramped request sizes (slow links move little
  data, fast links move a lot), and concurrent latency probes measure the RTT while the link is
  saturated.

## Packages

| Package | What it is |
| --- | --- |
| `@staffetta/core` | Protocol types, wire contract, measurement math. Zero dependencies, isomorphic. |
| `@staffetta/client` | The test engine: `runSpeedtest()`. |
| `@staffetta/server` | Fetch handler, Node adapter (`/node`), stream primitives. |
| `@staffetta/react` | `useSpeedtest()` hook over the client. |
| `@staffetta/vue` | `useSpeedtest()` composable over the client. |
| `@staffetta/angular` | Signal-based `SpeedtestService` over the client. |

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

### Express / NestJS / Fastify middleware

The pass-through variant of the listener: requests outside the three protocol endpoints fall
through to `next()`, so it composes with the rest of the application. Register it globally
(mounting it under a sub-path would strip the prefix the URL is matched against) — it handles
the endpoints before the framework's routing and body parsing, keeping interceptors, guards
and JSON body parsers off the measured path.

```ts
import {createSpeedtestNodeMiddleware} from '@staffetta/server/node'

// Express
app.use(createSpeedtestNodeMiddleware())

// NestJS — main.ts (Express adapter, or Fastify via @fastify/middie)
const app = await NestFactory.create(AppModule)
app.use(createSpeedtestNodeMiddleware())
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
  headers: () => ({authorization: `Bearer ${getToken()}`}), // resolved before each transfer request
  signal: abortController.signal,
  onPhase: phase => console.log(`— ${phase}`),
  onSample: sample => console.log(sample),
})

// result: {timestamp, target,
//          latency: {avgMs, minMs, maxMs, p50Ms, p90Ms, jitterMs},
//          download: {avgMbps, minMbps, maxMbps, p50Mbps, p90Mbps, stabilityCv}, upload: {…},
//          loadedLatency: {download: {…}, upload: {…}, bufferbloatMs},
//          verdict: 'optimal' | 'good' | 'unstable' | 'critical',
//          verdictReasons: ['jitter', 'download-stability', …]}
```

Tune the run with `config` and the verdict with `thresholds`; defaults live in `@staffetta/core`:

```ts
config: {
  pingCount: 16,                          // measured pings (plus a discarded warm-up)
  transferDurationMs: 8000,               // target duration of each transfer phase
  warmupMs: 1000,                         // minimum warm-up excluded from the stats (it extends adaptively until steady state)
  initialRequestSizeBytes: 262_144,       // first request of the adaptive size ramp (256 KiB)
  maxRequestSizeBytes: 67_108_864,        // ramp cap (64 MiB) — keep it under the server's maxSizeBytes
  connections: 3,                         // parallel streams per transfer phase
  loadedPingIntervalMs: 250,              // latency probes under load; 0 disables loadedLatency
  sampleIntervalMs: 250,                  // throughput sampling window
  stabilityIntervalMs: 500,               // windows the stability CV is judged on (multiple of sampleIntervalMs)
  phaseTimeoutMs: 120_000,                // safety timeout per phase
}
```

**Timeouts keep what they measured.** When a phase's safety timeout fires (e.g. an upload POST
that never completes on a dying connection), `runSpeedtest` rejects with `SpeedtestTimeoutError`,
whose `partial` field carries the completed phases plus whatever the interrupted phase collected
— enough to see that ping and download were fine and the upload is what hangs. No verdict is
computed for a partial result. User aborts and network failures reject with the underlying error
as before.

**Latency under load (bufferbloat).** While download and upload run, the client keeps probing
the ping endpoint. `loadedLatency` reports the RTT stats per direction plus `bufferbloatMs` —
the worst-direction median loaded RTT minus the idle median. A connection can be fast and still
unusable for calls or gaming when its buffers bloat under load. In a browser the probes share
the transfer's HTTP/2 connection (even on another hostname, which gets coalesced), so they also
wait behind the server's send buffer and overstate the network's bufferbloat: by default it only
keeps the verdict from `optimal` (`optimalMaxBufferbloatMs`). Set `unstableMinBufferbloatMs` to
let it report `unstable` when your probes are known to travel on their own connection.

**Why the verdict.** `verdictReasons` lists the measures that held the verdict at its level —
the failed minimums for `critical`, the tripped thresholds for `unstable`, the missed optimal
bounds for `good` — and is empty for `optimal`. `assessVerdict` from `@staffetta/core` returns
the same `{verdict, reasons}` for measures you computed yourself.

The verdict also judges the absolute idle latency, not just its stability: a link with a rock
solid 300 ms median RTT moves bulk data at full speed and is still unusable interactively, so
it reports `unstable` above `unstableMinLatencyMs` (250 ms by default) and never better than
`good` above `optimalMaxLatencyMs` (80 ms by default).

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

## Vue

```vue
<script setup lang="ts">
import {useSpeedtest} from '@staffetta/vue'

const {status, log, start, cancel} = useSpeedtest({baseUrl: 'https://api.example.com'})
</script>

<template>
  <div>
    <button v-if="status.kind === 'idle'" @click="start">Run speedtest</button>
    <button v-if="status.kind === 'running'" @click="cancel">Cancel ({{ status.phase }}…)</button>
    <pre v-if="status.kind === 'done'">{{ status.result }}</pre>
    <p v-if="status.kind === 'error'">Test failed: {{ status.reason }}</p>
    <ul><li v-for="(entry, idx) in log" :key="idx">{{ entry }}</li></ul>
  </div>
</template>
```

## Angular

```ts
import {Component, inject} from '@angular/core'
import {provideSpeedtest, SpeedtestService} from '@staffetta/angular'

@Component({
  selector: 'speedtest-panel',
  providers: [provideSpeedtest()],
  template: `…` // read speedtest.status() and speedtest.log(), both signals
})
export class SpeedtestPanel {
  readonly speedtest = inject(SpeedtestService)
  // speedtest.start({baseUrl: 'https://api.example.com'}) / speedtest.cancel()
}
```

The service is decorator-free (plain class + signals), so the package ships as regular ESM
with no Angular compiler in the loop; `provideSpeedtest()` registers it in a component's
`providers` (one test per component, aborted on destroy) or in the bootstrap providers.

## Measuring accurately

The math is only as good as the timestamps it is fed. These are the pitfalls found running
staffetta against real deployments; most of them make a good link look `unstable`.

**Run the client off the main thread.** `runSpeedtest` only needs `fetch`, so it runs as is in a
Web Worker. On the main thread, any UI work (re-renders, incoming notifications, a development
build of your framework) delays the moment a response is observed: idle pings get spikes that
inflate the jitter, and body chunks are read in bursts that fake throughput stalls. Forward
`onPhase`/`onSample` to the page with `postMessage`, and cancel by terminating the worker.

**Disable reverse-proxy buffering on the download.** nginx buffers the upstream response by
default and forwards it in bursts: the throughput windows alternate between zero and spikes,
and the latency probes queue behind the buffered data. The fetch handler replies
`X-Accel-Buffering: no` on the download; add it yourself if you wire the raw primitives into your
own endpoints (or set `proxy_buffering off` on their location). nginx also buffers request
bodies (`proxy_request_buffering`): the upload still measures correctly, since the client falls
back to its own clock when the server reports an implausibly short receive time.

**Mind cross-origin requests.** When the page and the server live on different origins, a
request carrying a custom header (e.g. an auth header) or the upload's
`application/octet-stream` body is preceded by a CORS preflight. Chromium does not reuse cached
preflights for `cache: 'no-store'` requests, which the client uses to keep caches out of the
measurement, so each such request pays an extra round trip. The client therefore sends the
`headers` option on download and upload only: ping is anonymous by design and stays a simple
request, otherwise every probe would measure twice the real RTT. Serve the page from the same
origin as the server when you can, so the transfers skip the preflight too.

**Latency under load is pessimistic in browsers.** The probes share the transfer's HTTP/2
connection, also when they target another hostname (browsers coalesce connections to the same
IP and certificate), so they wait behind the server's send buffer as well as the network's
queues. This is why bufferbloat alone does not report `unstable` by default.

**Upload stability is coarse.** `fetch` cannot observe an upload in progress, so each POST is
spread uniformly over its duration and the upload CV mostly reflects the variation between
POSTs, not within them.

**Browser throttling is not a degraded network.** Chrome DevTools throttling adds latency per
request and caps the overall rate; its packet loss, queue and reordering settings apply to
WebRTC only. "Disable cache" also disables the preflight cache. Use an OS-level shaper (macOS
Network Link Conditioner, `dnctl`/`pfctl`, Linux `tc netem`) to test real loss.

**Comparing with public speedtests.** Ookla or fast.com measure to a nearby server dedicated to
the test and report averages. staffetta measures to *your* server through its whole stack
(CDN, reverse proxy, application) and judges the stability as well, which is the point: the
same line can be fast towards a speedtest server and irregular towards your application.

## The protocol

Any server that speaks these three endpoints can be measured by the client — the reference
implementation is `@staffetta/server`, but a Go or Python one works the same. All responses
carry `cache-control: no-store`.

| Endpoint | Behaviour |
| --- | --- |
| `GET {base}/ping` | Reply immediately with minimal JSON: `{"pong": true}`. The client measures the full round trip (a warm-up request is sent first and discarded, keeping TCP/TLS setup out of the samples). |
| `GET {base}/download?size=N` | Stream exactly `N` bytes of **incompressible** data as `application/octet-stream` with an explicit `content-length`. Incompressible, or transparent compression on the path inflates the measurement. Reply `400` for a non-integer, non-positive or over-limit `size`. |
| `POST {base}/upload` | Count and discard the raw `application/octet-stream` body, reply `{"bytesReceived": n, "serverElapsedMs": n}` and `413` over the limit. |

`serverElapsedMs` is the server-side first-to-last-byte receive time. The client uses it as
the upload time base of the windowed statistics because it excludes the request and response
round trips; servers that cannot measure it reply `0` and the client falls back to its own
clock.

**Why chunked uploads?** Upload progress is not observable with `fetch()` (request-body
streaming needs HTTP/2 plus `duplex: 'half'`), so each upload stream sends POSTs sized to
carry the observed rate through the remaining phase time, and pipelines them at depth 2: the
next POST is dispatched about one idle RTT before the current one finishes sending, so the
reply round trip overlaps the next send instead of idling the link. Completed chunks are
spread over their transfer time for the windowed stats — the server-measured receive time,
bounded by the client's own clock minus one round trip, so a server draining its buffers in
bursts cannot collapse the sample. Uploaded bytes are
incompressible random data — like the download side, so transparent compression on the path
cannot inflate the measurement.

**How the client drives the endpoints.** The protocol stays three plain endpoints; the
methodology lives client-side: `connections` parallel streams transfer for
`transferDurationMs`, each request sized to span the remaining phase time at the observed
rate. Download streams prefetch the next request one idle RTT before the current body drains
(and in-flight downloads are aborted at the deadline; the received bytes still count), so the
per-request round trip never shows up as a throughput gap. The warm-up excluded from the
statistics starts at `warmupMs` and extends adaptively until the throughput reaches steady
state (capped at half the phase), covering TCP slow start on high-BDP links. The ping endpoint
doubles as the under-load latency probe — another reason it stays anonymous and instant.

## Development

```sh
pnpm install
pnpm build
pnpm test
```

## License

[MIT](./LICENSE)
