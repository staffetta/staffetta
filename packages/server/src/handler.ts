import {SpeedtestDefaultMaxSizeBytes, type SpeedtestPhase, type SpeedtestPingReply} from '@staffetta/core'
import {consumeUploadStream, createDownloadStream, SpeedtestPayloadTooLargeError} from './streams.ts'

/** Path prefix the three endpoints are served under when `basePath` is not given. */
export const SpeedtestDefaultBasePath = '/speedtest'

export interface SpeedtestHandlerOptions {
  /** Path prefix the three endpoints are served under. Default: `/speedtest`. */
  basePath?: undefined | string
  /** Max bytes accepted for one download or upload. Default: 200 MiB. */
  maxSizeBytes?: undefined | number
  /**
   * Optional per-request gate; return false to reply 401. Runs for download/upload only:
   * ping is anonymous by design, so the client measures the pure network RTT instead of
   * auth time. Wrap the handler with your own middleware for anything stronger.
   */
  authorize?: undefined | ((request: Request, phase: SpeedtestPhase) => boolean | Promise<boolean>)
}

/**
 * Web-standard request handler implementing the staffetta protocol. Mount it directly in any
 * fetch-based runtime (Hono, Next.js route handlers, Bun, Deno, Cloudflare Workers, SvelteKit)
 * or through an adapter (`@staffetta/server/node` for Node http/Express/Fastify).
 *
 * Replies 404 for anything outside `{basePath}/ping|download|upload`.
 */
export function createSpeedtestFetchHandler(
  options: SpeedtestHandlerOptions = {},
): (request: Request) => Promise<Response> {
  const basePath = options.basePath ?? SpeedtestDefaultBasePath
  const maxSizeBytes = options.maxSizeBytes ?? SpeedtestDefaultMaxSizeBytes

  return async function handleSpeedtestRequest(request: Request): Promise<Response> {
    const url = new URL(request.url)
    const phase = resolveSpeedtestPhase(url.pathname, basePath)

    if (!phase) {
      return jsonResponse(404, {error: 'not found'})
    }
    if (request.method !== (phase === 'upload' ? 'POST' : 'GET')) {
      return jsonResponse(405, {error: 'method not allowed'})
    }
    if (phase !== 'ping' && options.authorize && !(await options.authorize(request, phase))) {
      return jsonResponse(401, {error: 'unauthorized'})
    }

    switch (phase) {
      case 'ping':
        return jsonResponse(200, {pong: true} satisfies SpeedtestPingReply)
      case 'download':
        return handleDownload(url, maxSizeBytes)
      case 'upload':
        return handleUpload(request, maxSizeBytes)
    }
  }
}

function handleDownload(url: URL, maxSizeBytes: number): Response {
  const size = Number(url.searchParams.get('size'))

  if (!Number.isInteger(size) || size < 1 || size > maxSizeBytes) {
    return jsonResponse(400, {error: `size must be an integer between 1 and ${maxSizeBytes}`})
  }

  return new Response(createDownloadStream(size), {
    status: 200,
    headers: {
      'content-type': 'application/octet-stream',
      'content-length': String(size),
      'cache-control': 'no-store',
    },
  })
}

async function handleUpload(request: Request, maxSizeBytes: number): Promise<Response> {
  const contentLength = Number(request.headers.get('content-length'))

  if (Number.isFinite(contentLength) && contentLength > maxSizeBytes) {
    return jsonResponse(413, {error: `upload exceeds the ${maxSizeBytes} bytes limit`})
  }
  if (!request.body) {
    return jsonResponse(400, {error: 'expected a binary (application/octet-stream) request body'})
  }

  try {
    const reply = await consumeUploadStream(request.body, {maxBytes: maxSizeBytes})
    return jsonResponse(200, reply)
  } catch (error) {
    if (error instanceof SpeedtestPayloadTooLargeError) {
      return jsonResponse(413, {error: error.message})
    }
    throw error
  }
}

/** Maps a request pathname to the protocol phase it addresses, or `undefined` outside the three endpoints. */
export function resolveSpeedtestPhase(pathname: string, basePath: string): SpeedtestPhase | undefined {
  const normalizedBase = basePath.endsWith('/') ? basePath.slice(0, -1) : basePath

  switch (pathname) {
    case `${normalizedBase}/ping`:
      return 'ping'
    case `${normalizedBase}/download`:
      return 'download'
    case `${normalizedBase}/upload`:
      return 'upload'
    default:
      return undefined
  }
}

function jsonResponse(status: number, body: object): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {'content-type': 'application/json', 'cache-control': 'no-store'},
  })
}
