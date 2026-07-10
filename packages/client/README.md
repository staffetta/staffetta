# @staffetta/client

Client engine of the [staffetta](https://github.com/staffetta/staffetta) speedtest: runs the
ping → download → upload relay against any server implementing the protocol (reference
implementation: [`@staffetta/server`](https://www.npmjs.com/package/@staffetta/server)).
Framework-free, `fetch`-based — runs in browsers and Node.

## Install

```sh
npm install @staffetta/client
```

## Usage

```ts
import {runSpeedtest} from '@staffetta/client'

const result = await runSpeedtest({
  baseUrl: 'https://api.example.com',
  headers: () => ({authorization: `Bearer ${getToken()}`}), // resolved before each request
  signal: abortController.signal,
  onPhase: phase => console.log(`— ${phase}`),
  onSample: sample => console.log(sample),
})

// result: {timestamp, target,
//          latency: {avgMs, minMs, maxMs, p50Ms, p90Ms, jitterMs},
//          download: {avgMbps, minMbps, maxMbps, p50Mbps, p90Mbps, stabilityCv}, upload: {…},
//          loadedLatency: {download: {…}, upload: {…}, bufferbloatMs},
//          verdict: 'optimal' | 'good' | 'unstable' | 'critical'}
```

Tune the run with `config` and the verdict with `thresholds`; defaults live in
`@staffetta/core`:

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
  phaseTimeoutMs: 120_000,                // safety timeout per phase
}
```

**Timeouts keep what they measured.** When a phase's safety timeout fires, `runSpeedtest`
rejects with `SpeedtestTimeoutError`, whose `partial` field carries the completed phases plus
whatever the interrupted phase collected — enough to see that ping and download were fine and
the upload is what hangs.

**Latency under load (bufferbloat).** While download and upload run, the client keeps probing
the ping endpoint; `loadedLatency` reports the RTT stats per direction plus `bufferbloatMs`,
and the verdict accounts for it.

Full methodology (parallel streams, adaptive size ramp, request overlap, warm-up handling)
and protocol spec: [github.com/staffetta/staffetta](https://github.com/staffetta/staffetta).
React bindings: [`@staffetta/react`](https://www.npmjs.com/package/@staffetta/react).

## License

[MIT](./LICENSE)
