# @staffetta/server

Server side of the [staffetta](https://github.com/staffetta/staffetta) speedtest: stream
primitives, a Web-standard fetch handler and a Node `http` adapter. Framework-agnostic —
no third-party measurement servers, you mount three endpoints on your own backend and measure
the path your users actually use.

## Install

```sh
npm install @staffetta/server
```

## Fetch-based runtimes (Hono, Next.js, Bun, Deno, Workers…)

```ts
import {createSpeedtestFetchHandler} from '@staffetta/server'

const speedtest = createSpeedtestFetchHandler()

// Hono
app.all('/speedtest/*', c => speedtest(c.req.raw))

// Next.js — app/speedtest/[[...slug]]/route.ts
export const GET = speedtest
export const POST = speedtest
```

## Node http / Express

```ts
import {createServer} from 'node:http'
import {createSpeedtestNodeListener} from '@staffetta/server/node'

createServer(createSpeedtestNodeListener()).listen(8080)

// Express
app.use(createSpeedtestNodeListener())
```

## Options

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

## Raw primitives

If you'd rather wire the endpoints into your own controllers (NestJS, Fastify, anything):

```ts
import {createDownloadStream, consumeUploadStream} from '@staffetta/server'

createDownloadStream(sizeBytes)                    // ReadableStream of incompressible bytes
await consumeUploadStream(body, {maxBytes})        // → {bytesReceived, serverElapsedMs}
```

The endpoints implement an open protocol — any client speaking it can measure this server,
and the [`@staffetta/client`](https://www.npmjs.com/package/@staffetta/client) engine can
measure any server implementing it. Protocol spec and methodology:
[github.com/staffetta/staffetta](https://github.com/staffetta/staffetta).

## License

[MIT](./LICENSE)
