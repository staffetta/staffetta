import type {SpeedtestUploadReply} from '@staffetta/core'

/** Thrown by {@link consumeUploadStream} when the body exceeds the configured limit. */
export class SpeedtestPayloadTooLargeError extends Error {
  constructor(maxBytes: number) {
    super(`Speedtest upload exceeds the ${maxBytes} bytes limit`)
    this.name = 'SpeedtestPayloadTooLargeError'
  }
}

// Random template generated once and reused: chunk generation must not become a
// CPU bottleneck that skews the network measurement, while random content avoids
// transparent compression along the path inflating the measured throughput.
let chunkTemplate: undefined | Uint8Array

function getChunkTemplate(): Uint8Array {
  if (!chunkTemplate) {
    chunkTemplate = new Uint8Array(65_536)
    crypto.getRandomValues(chunkTemplate)
  }
  return chunkTemplate
}

/** Streams exactly `sizeBytes` of incompressible bytes, honoring backpressure. */
export function createDownloadStream(sizeBytes: number): ReadableStream<Uint8Array> {
  const template = getChunkTemplate()
  let remainingBytes = sizeBytes

  return new ReadableStream<Uint8Array>({
    pull(controller) {
      const chunk = remainingBytes >= template.length ? template : template.subarray(0, remainingBytes)

      remainingBytes -= chunk.length
      controller.enqueue(chunk)

      if (remainingBytes <= 0) {
        controller.close()
      }
    },
  })
}

/**
 * Counts and discards the request body. `serverElapsedMs` is the first-to-last-byte receive
 * time: it excludes the response round trip, so the client can use it as the sample time base.
 */
export async function consumeUploadStream(
  stream: ReadableStream<Uint8Array>,
  args: {maxBytes: number},
): Promise<SpeedtestUploadReply> {
  let bytesReceived = 0
  let firstByteAt: undefined | number

  for await (const chunk of stream) {
    firstByteAt ??= performance.now()
    bytesReceived += chunk.length

    if (bytesReceived > args.maxBytes) {
      // Exiting the for-await loop releases the reader and cancels the stream.
      throw new SpeedtestPayloadTooLargeError(args.maxBytes)
    }
  }

  const serverElapsedMs = firstByteAt === undefined ? 0 : Math.round(performance.now() - firstByteAt)

  return {bytesReceived, serverElapsedMs}
}
