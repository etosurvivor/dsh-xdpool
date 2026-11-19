import { afterEach, describe, expect, it } from 'vitest'
import { createServer, type RequestListener } from 'node:http'
import { createRouteLoopbackFetch } from '../src/route-transport.ts'

const cleanup: (() => Promise<void>)[] = []
afterEach(async () => { while (cleanup.length > 0) await cleanup.pop()!() })

async function serve(handler: RequestListener) {
  const server = createServer(handler)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  cleanup.push(() => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections() }))
  const address = server.address()
  if (typeof address !== 'object' || address === null) throw new Error('missing test address')
  const base = `http://127.0.0.1:${address.port}`
  return { endpoint: `${base}/v1/chat/completions`, fetch: createRouteLoopbackFetch(() => base) }
}

describe('route loopback transport', () => {
  it('preserves a completion request and its eventual HTTP error and body', async () => {
    const incoming: unknown[] = []
    const x = await serve(async (request, response) => {
      const buffers: Buffer[] = []
      for await (const chunk of request) buffers.push(chunk as Buffer)
      incoming.push(request.method, request.headers.authorization, Buffer.concat(buffers).toString())
      response.writeHead(504, { 'Content-Type': 'application/json', 'Retry-After': '3' })
      response.end('{"error":{"code":"combo_timeout"}}')
    })
    const r = await x.fetch(x.endpoint, { method: 'POST', body: '{"test":"中文"}', headers: { authorization: 'Bearer dummy' } })
    expect(r.status).toBe(504)
    expect(r.headers.get('retry-after')).toBe('3')
    expect(await r.json()).toEqual({ error: { code: 'combo_timeout' } })
    expect(incoming).toEqual(['POST', 'Bearer dummy', '{"test":"中文"}'])
  })

  it('closes the socket when a caller cancels while waiting for headers', async () => {
    let arrived!: () => void
    const requestReceived = new Promise<void>(resolve => { arrived = resolve })
    let disconnected!: () => void
    const connectionClosed = new Promise<void>(resolve => { disconnected = resolve })
    const x = await serve((_request, response) => {
      response.once('close', disconnected)
      arrived()
    })
    const controller = new AbortController()
    const reply = x.fetch(x.endpoint, { method: 'POST', body: '{}', signal: controller.signal })
    await requestReceived
    controller.abort()
    await expect(reply).rejects.toMatchObject({ name: 'AbortError' })
    await connectionClosed
  })

  it('closes a streaming response if the caller cancels after headers', async () => {
    let disconnected!: () => void
    const connectionClosed = new Promise<void>(resolve => { disconnected = resolve })
    const x = await serve((_request, response) => {
      response.once('close', disconnected)
      response.writeHead(200, { 'Content-Type': 'text/event-stream' })
      response.write('data: a\n\n')
    })
    const controller = new AbortController()
    const reply = await x.fetch(x.endpoint, { method: 'POST', body: '{}', signal: controller.signal })
    const reader = reply.body!.getReader()
    expect(new TextDecoder().decode((await reader.read()).value)).toBe('data: a\n\n')
    controller.abort()
    await expect(reader.read()).rejects.toThrow()
    await connectionClosed
  })
})
