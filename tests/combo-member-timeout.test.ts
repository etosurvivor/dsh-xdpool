import { afterEach, describe, expect, it, vi } from 'vitest'
import { setTimeout as sleep } from 'node:timers/promises'
import { createServer, type Server } from 'node:http'
import { AggregateCatalog } from '../src/aggregate.ts'
import { createWorkBuddyAdapter } from '../src/adapter.ts'
import { WorkBuddyCatalog, type WorkBuddyModelInfo } from '../src/catalog.ts'
import { createChannelLane, type ChannelLaneLlm } from '../src/channel-lane.ts'
import type { WorkBuddyAccountPool } from '../src/accounts.ts'
import type { WorkBuddyUpstreamClient } from '../src/upstream.ts'
import type { AggregateStore } from '../src/store.ts'
import { createWorkBuddyShim } from '../src/shim.ts'
import { UsageRecorder } from '../src/stats.ts'

const close: (() => Promise<void>)[] = []
afterEach(async () => { while (close.length) await close.pop()!() })
const fallback = 'trae:flash'
const loomy = 'loomy:flash'
const text = (value: string) => ({ type: 'text-delta', index: 0, text: value })
const finish = (kind = 'stop') => ({ type: 'finish', reason: { kind } })
const sseText = (value: string) => `data: ${JSON.stringify({ choices: [{ delta: { content: value } }] })}\n\n`
const usageTrailer = 'data: {"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":20}}\n\ndata: [DONE]\n\n'

async function setup(input: {
  first?: string
  loomyStream?: ChannelLaneLlm['stream']
  workbuddy?: WorkBuddyUpstreamClient['chatStream']
  providers?: AggregateStore['providers']
  firstMs?: number
  idleMs?: number
}) {
  const attempted: string[] = []
  const usageRecorder = new UsageRecorder()
  const llm: ChannelLaneLlm = {
    listModels: async () => [{ id: 'flash' }],
    stream: options => {
      attempted.push(String(options.provider))
      if (options.provider === 'loomy' && input.loomyStream !== undefined) return input.loomyStream(options)
      return (async function* () { yield text('fallback reply'); yield finish() })()
    },
  }
  const channels = createChannelLane({ llm, providers: () => ['loomy', 'trae'], toId: (p, m) => `${p}:${m}` })
  const hosts = await channels.rows()
  const poolModel = { id: 'pool-flash', name: 'pool-flash', contextWindow: 100_000, maxOutputTokens: 4096, supportsImages: false } as WorkBuddyModelInfo
  const poolCatalog = input.workbuddy === undefined ? new WorkBuddyCatalog('cn') : { current: () => [poolModel], find: () => poolModel } as unknown as WorkBuddyCatalog
  const account = { id: 'pool-account', label: 'test', credential: { accessToken: 'test' } }
  const pool = { list: () => [account], acquire: async () => account, noteServed: () => {}, expiryReadingOf: () => ({ stale: false }) } as unknown as WorkBuddyAccountPool
  const client = { chatStream: input.workbuddy, prepareChatBodyFor: (raw: string) => raw, fetchCredits: async () => { throw new Error('not needed') } } as unknown as WorkBuddyUpstreamClient
  const store: AggregateStore = { version: 1, ...(input.providers === undefined ? {} : { providers: input.providers }),
    combos: [{ name: 'timeout', models: [input.first ?? loomy, fallback], strategy: 'fallback' }] }
  const catalog = new AggregateCatalog(() => store, () => poolCatalog.current(), () => hosts)
  await catalog.refresh()
  const shim = createWorkBuddyShim({ pool, client, catalog: poolCatalog, channels, usageRecorder,
    aggregate: { catalog, readStore: () => store }, comboTimeouts: { firstOutputMs: input.firstMs ?? 450, idleMs: input.idleMs ?? 160 } })
  close.push(() => shim.close())
  await shim.ready
  const ask = (stream = false, signal?: AbortSignal, session = 'timing-test') => fetch(`${shim.baseUrl()}/v1/chat/completions`, {
    method: 'POST', headers: { authorization: `Bearer ${shim.token()}`, 'content-type': 'application/json', 'x-session-id': session },
    body: JSON.stringify({ model: 'combo:timeout', stream, messages: [{ role: 'user', content: 'test' }] }),
    ...(signal === undefined ? {} : { signal }),
  })
  return { ask, attempted, usageRecorder, lastRoute: () => shim.routeLastUsed('timing-test', 'combo:timeout') }
}

async function upstream(write: (response: import('node:http').ServerResponse) => void): Promise<Server> {
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/event-stream' })
    write(response)
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  close.push(() => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections() }))
  return server
}

function aggregateSettings(server: Server): AggregateStore['providers'] {
  const address = server.address() as { port: number }
  return { agnes: { apiKey: 'fake', baseUrl: `http://127.0.0.1:${address.port}/v1`, enabled: true } }
}

describe('route output deadlines', () => {
  it('lets routed pi-ai calls wait past the default connection timeout', async () => {
    const timeouts: string[] = []
    const server = await upstream(response => {
      timeouts.push(String(response.req.headers['x-stainless-timeout']))
      const timer = setTimeout(() => {
        response.end('data: {"id":"one","choices":[{"index":0,"delta":{"content":"complete"},"finish_reason":null}]}\n\n'
          + 'data: {"id":"one","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n')
      }, 230)
      response.once('close', () => clearTimeout(timer))
    })
    const address = server.address() as { port: number }
    const direct = 'agnes/agnes-2.0-flash'
    const store: AggregateStore = { version: 1, providers: aggregateSettings(server)!,
      combos: [{ name: 'timeout', models: [direct], strategy: 'fallback' }] }
    const catalog = new AggregateCatalog(() => store)
    await catalog.refresh()
    const shim = { baseUrl: () => `http://127.0.0.1:${address.port}`, token: () => 'test' } as Parameters<typeof createWorkBuddyAdapter>[0]['shim']
    const provider = 'xdpool-aggregate'
    const adapter = createWorkBuddyAdapter({ shim, catalog, providerId: provider, ctx: { get: () => undefined } as never }).adapter
    const defaultFetch = globalThis.fetch
    const constrainedFetch = vi.fn<typeof fetch>((target, init) => {
      const headerLimit = AbortSignal.timeout(90)
      const signal = init?.signal == null ? headerLimit : AbortSignal.any([headerLimit, init.signal])
      return defaultFetch(target, { ...init, signal })
    })
    vi.stubGlobal('fetch', constrainedFetch)
    try {
      for (const [model, kind] of [[direct, 'error'], ['combo:timeout', 'stop']] as const) {
        const prepared = await adapter.prepareCall(provider, model)
        const chunks = []
        for await (const chunk of prepared.stream({ provider, model, messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] as never })) chunks.push(chunk)
        expect(chunks).toContainEqual(expect.objectContaining({ type: 'finish', reason: expect.objectContaining({ kind }) }))
      }
      expect(constrainedFetch).toHaveBeenCalledTimes(1)
    } finally { vi.unstubAllGlobals() }
    expect(Number(timeouts[0] === 'undefined' ? '600' : timeouts[0])).toBeLessThan(1200)
    expect(Number(timeouts[1])).toBeGreaterThan(1200)
  })

  it('allows a silent first response and a continuously active stream beyond the original deadline', async () => {
    const x = await setup({ firstMs: 400, idleMs: 160, loomyStream: () => (async function* () {
      await sleep(220)
      yield { type: 'reasoning-delta', index: 0, text: 'thinking' }
      await sleep(220)
      for (let i = 0; i < 6; i += 1) { await sleep(55); yield text('active ') }
      yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 } }
      yield finish()
    })() })
    const r = await x.ask(true)
    const body = await r.text()
    expect(r.status).toBe(200)
    expect(body).toContain('thinking')
    expect(body.match(/active /gu)).toHaveLength(6)
    expect(x.attempted).toEqual(['loomy'])
    expect(await x.lastRoute()).toMatchObject({ channel: 'Loomy', decode: { decodeTokens: 20 } })
    expect((await x.lastRoute())?.decode?.decodeMs).toBeGreaterThan(500)
  })

  it('falls back on first-output timeout even if an adapter ignores cancellation', async () => {
    const x = await setup({ firstMs: 100, loomyStream: () => (async function* () {
      yield text('')
      await new Promise<void>(() => {})
    })() })
    const response = await x.ask()
    expect(await response.text()).toContain('fallback reply')
    expect(x.attempted).toEqual(['loomy', 'trae'])
    expect(x.usageRecorder.summary()).toMatchObject({ recoveredTurns: 1, failedTurns: 0 })
  })

  it.each(['stalled', 'aborted'])('falls back after a %s host stream and discards its partial output', async failure => {
    const x = await setup({ idleMs: 85, loomyStream: options => (async function* () {
      yield text('partial Loomy answer')
      if (failure === 'stalled') await sleep(1000, undefined, { signal: options.signal as AbortSignal })
      else yield finish('aborted')
    })() })
    const response = await x.ask(true)
    const body = await response.text()
    expect(response.status).toBe(200)
    expect(body).toContain('fallback reply')
    expect(body).not.toContain('partial Loomy answer')
    expect(body).not.toContain('"finish_reason":"abort"')
    expect(x.usageRecorder.summary().entries.map(entry => entry.ok)).toEqual([true, false])
    expect(await x.lastRoute()).toMatchObject({ channel: 'TRAE' })
    expect((await x.lastRoute())?.decode).toBeUndefined()
  })

  it('does not start another member on caller cancellation', async () => {
    let active!: () => void
    const started = new Promise<void>(resolve => { active = resolve })
    const x = await setup({ loomyStream: options => (async function* () {
      active()
      await sleep(1000, undefined, { signal: options.signal as AbortSignal })
      yield text('too late')
    })() })
    const controller = new AbortController()
    const response = x.ask(false, controller.signal)
    await started
    controller.abort()
    await expect(response).rejects.toThrow()
    await sleep(50)
    expect(x.attempted).toEqual(['loomy'])
  })

  it('falls back on a stalled WorkBuddy HTTP 200 stream without leaking the partial reply', async () => {
    const x = await setup({ first: 'pool-flash', idleMs: 80, workbuddy: async () => ({ ok: true, response: new Response(new ReadableStream({
      start(controller) { controller.enqueue(new TextEncoder().encode(sseText('partial pool output'))) },
    })) }) })
    const response = await x.ask(true)
    const body = await response.text()
    expect(response.status).toBe(200)
    expect(body).toContain('fallback reply')
    expect(body).not.toContain('partial pool output')
    expect(x.usageRecorder.summary().entries.map(entry => [entry.channel, entry.ok])).toEqual([['trae', true], ['workbuddy', false]])
  })

  it('measures WorkBuddy upstream output and withholds a speed for a later buffered answer', async () => {
    let streamed = true
    const x = await setup({ first: 'pool-flash', idleMs: 350, workbuddy: async () => ({
      ok: true,
      response: new Response(new ReadableStream({
        async start(controller) {
          const encoder = new TextEncoder()
          controller.enqueue(encoder.encode(sseText('first ')))
          if (streamed) await sleep(180)
          controller.enqueue(encoder.encode(sseText('second') + usageTrailer))
          controller.close()
        },
      })),
    }) })
    expect(await (await x.ask()).text()).toContain('first second')
    expect(await x.lastRoute()).toMatchObject({ channel: 'WorkBuddy 国内版', decode: { decodeTokens: 20 } })
    expect((await x.lastRoute())?.decode?.decodeMs).toBeGreaterThan(120)
    streamed = false
    expect(await (await x.ask()).text()).toContain('first second')
    expect((await x.lastRoute())?.decode).toBeUndefined()
  })

  it('keeps the aggregate member active as complete SSE output arrives', async () => {
    const server = await upstream(response => {
      let sent = 0
      const timer = setInterval(() => {
        response.write(sseText('aggregate output '))
        if (++sent === 9) response.end(usageTrailer)
      }, 50)
      response.once('close', () => clearInterval(timer))
    })
    const x = await setup({ first: 'agnes/agnes-2.0-flash', providers: aggregateSettings(server), firstMs: 340, idleMs: 150 })
    const response = await x.ask()
    expect((await response.text()).match(/aggregate output /gu)).toHaveLength(9)
    expect(x.attempted).toEqual([])
    expect((await x.lastRoute())?.decode).toMatchObject({ decodeTokens: 20 })
    expect((await x.lastRoute())?.decode?.decodeMs).toBeGreaterThan(350)
  })

  it('does not let aggregate keepalive comments hide a stalled response', async () => {
    const server = await upstream(response => {
      response.write(sseText('partial aggregate output'))
      const timer = setInterval(() => response.write(': keepalive\n\n'), 20)
      response.once('close', () => clearInterval(timer))
    })
    const x = await setup({ first: 'agnes/agnes-2.0-flash', providers: aggregateSettings(server), idleMs: 85 })
    const response = await x.ask()
    const body = await response.text()
    expect(body).toContain('fallback reply')
    expect(body).not.toContain('partial aggregate output')
    expect(x.usageRecorder.summary().entries.map(entry => [entry.channel, entry.ok])).toEqual([['trae', true], ['agnes', false]])
  })
})
