# @staffetta/core

Protocol types, wire contract and measurement math shared by the
[staffetta](https://github.com/staffetta/staffetta) speedtest client and server.
Zero dependencies, isomorphic — runs anywhere a `fetch`-era JS runtime does.

You normally don't install this directly: it comes in as a dependency of
[`@staffetta/client`](https://www.npmjs.com/package/@staffetta/client) and
[`@staffetta/server`](https://www.npmjs.com/package/@staffetta/server). Reach for it when you
implement the protocol yourself or post-process results.

## What's inside

- **Protocol** — the wire contract of the three endpoints (`ping`, `download`, `upload`):
  default paths, request/response shapes, `decodeUploadReply`.
- **Statistics** — the measurement math: windowed throughput samples, latency stats
  (avg/min/max/p50/p90, jitter), adaptive warm-up resolution, loaded latency (bufferbloat),
  `spreadTransferChunks`.
- **Verdict** — `computeVerdict` with configurable thresholds
  (`SpeedtestDefaultThresholds`): `optimal | good | unstable | critical`, judging throughput
  stability, absolute idle latency and bufferbloat.
- **Types** — `SpeedtestResult`, `SpeedtestPartialResult`, `SpeedtestConfig`,
  `SpeedtestProgressSample` and friends.

## Usage

```ts
import {computeVerdict, SpeedtestDefaultThresholds} from '@staffetta/core'

const verdict = computeVerdict(result, {...SpeedtestDefaultThresholds, optimalMaxLatencyMs: 50})
```

Full documentation, protocol spec and methodology:
[github.com/staffetta/staffetta](https://github.com/staffetta/staffetta).

## License

[MIT](./LICENSE)
