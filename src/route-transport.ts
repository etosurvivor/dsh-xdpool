import { request } from 'node:http'
import { Readable } from 'node:stream'

/**
 * Fetch adapter for the route's loopback POST. The router can wait on several
 * members before writing response headers. Node fetch has a separate header
 * deadline, even when pi-ai supplies a longer request signal. A private HTTP
 * request lets that signal govern the connection from headers through EOF.
 */
export function createRouteLoopbackFetch(baseUrl: () => string): typeof fetch {
  return async (input, init) => {
    const incoming = new Request(input, init)
    const url = new URL(incoming.url)
    const endpoint = new URL('/v1/chat/completions', baseUrl())
    if (url.protocol !== 'http:' || url.origin !== endpoint.origin
      || url.pathname !== endpoint.pathname || incoming.method !== 'POST') {
      throw new TypeError('the route transport only serves the plugin loopback completion endpoint')
    }
    incoming.signal.throwIfAborted()
    const body = Buffer.from(await incoming.arrayBuffer())
    incoming.signal.throwIfAborted()
    const headers = new Headers(incoming.headers)
    headers.set('content-length', String(body.length))

    return new Promise<Response>((resolve, reject) => {
      const outgoing = request(url, {
        method: incoming.method,
        headers: Object.fromEntries(headers),
        signal: incoming.signal,
        agent: false,
      }, reply => {
        const status = reply.statusCode ?? 500
        const responseHeaders = new Headers()
        for (let i = 0; i + 1 < reply.rawHeaders.length; i += 2) {
          responseHeaders.append(reply.rawHeaders[i]!, reply.rawHeaders[i + 1]!)
        }
        const isEmpty = status === 204 || status === 205 || status === 304
        const responseBody = isEmpty ? null : Readable.toWeb(reply) as ReadableStream<Uint8Array>
        if (isEmpty) reply.resume()
        resolve(new Response(responseBody, { status, headers: responseHeaders }))
      })
      outgoing.once('error', reject)
      outgoing.end(body)
    })
  }
}
