/**
 * The staffetta wire protocol. Any server (in any language) that implements these three
 * endpoints can be measured by the client:
 *
 * - `GET {ping}` — replies immediately with a minimal JSON body (`{"pong": true}`).
 *   The client measures the whole request/response round trip.
 * - `GET {download}?size=N` — streams exactly N bytes of incompressible
 *   (`application/octet-stream`) data with an explicit `content-length`.
 * - `POST {upload}` — counts and discards the raw `application/octet-stream` request body,
 *   then replies with {@link SpeedtestUploadReply}. `serverElapsedMs` is the first-to-last-byte
 *   receive time measured server-side; servers that cannot measure it reply `0` and the client
 *   falls back to its own clock (which also includes the response round trip).
 *
 * All responses must carry `cache-control: no-store`.
 */

/** Max payload accepted by the reference server for download/upload (200 MiB). */
export const SpeedtestDefaultMaxSizeBytes = 209_715_200

export interface SpeedtestPaths {
  ping: string
  download: string
  upload: string
}

export const SpeedtestDefaultPaths: SpeedtestPaths = {
  ping: '/speedtest/ping',
  download: '/speedtest/download',
  upload: '/speedtest/upload',
}

export interface SpeedtestPingReply {
  pong: true
}

export interface SpeedtestUploadReply {
  bytesReceived: number
  serverElapsedMs: number
}

/** Tolerant decoder for the upload reply: missing/invalid fields degrade to 0. */
export function decodeUploadReply(value: unknown): SpeedtestUploadReply {
  const raw = (value ?? {}) as {bytesReceived?: unknown; serverElapsedMs?: unknown}

  return {
    bytesReceived: asFiniteNumber(raw.bytesReceived),
    serverElapsedMs: asFiniteNumber(raw.serverElapsedMs),
  }
}

function asFiniteNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}
