import {createSpeedtestFetchHandler} from '@staffetta/server'

// Demo deployment: transfers are capped well below the library default (200 MiB) —
// the public demo shows the UX, it is not meant to saturate multi-gigabit links.
const speedtest = createSpeedtestFetchHandler({maxSizeBytes: 33_554_432})

// The demo page is served from another origin (github.io / localhost), and the upload
// POSTs application/octet-stream, which is not a CORS "simple request": the browser
// preflights it, so OPTIONS must be answered and every response must carry the headers.
const corsHeaders = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': 'content-type',
  'access-control-max-age': '86400',
}

export default {
  async fetch(request: Request): Promise<Response> {
    if (request.method === 'OPTIONS') {
      return new Response(null, {status: 204, headers: corsHeaders})
    }

    const response = await speedtest(request)
    const headers = new Headers(response.headers)
    for (const [name, value] of Object.entries(corsHeaders)) {
      headers.set(name, value)
    }
    return new Response(response.body, {status: response.status, headers})
  },
}
