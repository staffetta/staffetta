import type {IncomingMessage, ServerResponse} from 'node:http'
import {Readable} from 'node:stream'
import {
  createSpeedtestFetchHandler,
  resolveSpeedtestPhase,
  SpeedtestDefaultBasePath,
  type SpeedtestHandlerOptions,
} from './handler.ts'

export type NodeRequestListener = (request: IncomingMessage, response: ServerResponse) => void

export type NodeMiddleware = (
  request: IncomingMessage,
  response: ServerResponse,
  next: (error?: unknown) => void,
) => void

/**
 * Node `http` adapter over the fetch handler, usable directly with `http.createServer` or
 * mounted in Express (`app.use(createSpeedtestNodeListener())`). The listener answers every
 * request it receives (404 outside the speedtest paths), so mount it under its own route
 * prefix when composing with other routes.
 */
export function createSpeedtestNodeListener(options: SpeedtestHandlerOptions = {}): NodeRequestListener {
  const handler = createSpeedtestFetchHandler(options)

  return function speedtestNodeListener(request, response) {
    toFetchRequest(request)
      .then(handler)
      .then(fetchResponse => writeNodeResponse(fetchResponse, response))
      .catch((error: unknown) => {
        if (!response.headersSent) {
          response.writeHead(500, {'content-type': 'application/json'})
          response.end(JSON.stringify({error: 'internal error'}))
        } else {
          response.destroy()
        }
        request.socket.emit('error', error) // Surfaces through the server 'clientError'/'error' handling.
      })
  }
}

/**
 * Connect-style pass-through variant of the listener: requests outside the three protocol
 * endpoints fall through to `next()`, so it composes with the rest of an application without
 * claiming a route prefix. Register it globally (Express `app.use(...)`, NestJS
 * `app.use(...)` in `main.ts` or `MiddlewareConsumer#apply`, Fastify via `@fastify/middie`);
 * mounting it under a sub-path (`app.use('/x', ...)`) would strip the prefix `request.url`
 * is matched against.
 */
export function createSpeedtestNodeMiddleware(options: SpeedtestHandlerOptions = {}): NodeMiddleware {
  const listener = createSpeedtestNodeListener(options)
  const basePath = options.basePath ?? SpeedtestDefaultBasePath

  return function speedtestNodeMiddleware(request, response, next) {
    const pathname = (request.url ?? '/').split('?', 1)[0] ?? '/'

    if (resolveSpeedtestPhase(pathname, basePath)) {
      listener(request, response)
    } else {
      next()
    }
  }
}

async function toFetchRequest(request: IncomingMessage): Promise<Request> {
  const url = `http://${request.headers.host ?? 'localhost'}${request.url ?? '/'}`
  const method = request.method ?? 'GET'
  const headers = new Headers()

  for (const [name, value] of Object.entries(request.headers)) {
    if (typeof value === 'string') {
      headers.set(name, value)
    } else if (Array.isArray(value)) {
      for (const item of value) {
        headers.append(name, item)
      }
    }
  }

  const hasBody = method !== 'GET' && method !== 'HEAD'

  return new Request(url, {
    method,
    headers,
    body: hasBody ? (Readable.toWeb(request) as ReadableStream<Uint8Array>) : null,
    duplex: 'half',
  } as RequestInit)
}

async function writeNodeResponse(fetchResponse: Response, response: ServerResponse): Promise<void> {
  response.writeHead(fetchResponse.status, Object.fromEntries(fetchResponse.headers))

  if (!fetchResponse.body) {
    response.end()
    return
  }

  // pipeline() would be equivalent; manual piping keeps the client-abort path explicit:
  // destroying the response cancels the source stream, stopping chunk generation.
  const nodeBody = Readable.fromWeb(fetchResponse.body as Parameters<typeof Readable.fromWeb>[0])
  nodeBody.pipe(response)
  response.on('close', () => nodeBody.destroy())

  await new Promise<void>((resolve, reject) => {
    nodeBody.on('error', reject)
    response.on('finish', resolve)
    response.on('close', resolve)
  })
}
