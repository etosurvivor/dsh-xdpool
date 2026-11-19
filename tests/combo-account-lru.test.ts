import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AggregateCatalog } from '../src/aggregate.ts'
import { createChannelLane, type ChannelLaneLlm } from '../src/channel-lane.ts'
import { createChannelAccountRouting, type ChannelAccountEntry, type ChannelAccountPool } from '../src/channel-account-routing.ts'
import { createWorkBuddyShim } from '../src/shim.ts'
import type { WorkBuddyCatalog, WorkBuddyModelInfo } from '../src/catalog.ts'
import type { WorkBuddyAccountPool } from '../src/accounts.ts'
import type { ChatStreamResult, WorkBuddyUpstreamClient } from '../src/upstream.ts'

const shims: { close(): Promise<void> }[] = []
afterEach(async () => { while (shims.length) await shims.pop()!.close() })

async function setup(path?: string, includeGlobal = false) {
  const served: string[] = []
  const hostSessionIds: string[] = []
  const cooled = new Set<string>()
  const failOnce = new Set<string>()
  const upstreamFailures = new Map<string, Extract<ChatStreamResult, { ok: false }>>()
  const blockOnce = new Map<string, () => void>()
  const workAccounts = ['a', 'b'].map(id => ({ id, label: id, credential: { accessToken: id } }))
  const globalAccounts = [{ id: 'g', label: 'g', credential: { accessToken: 'g' } }]
  const pool = {
    list: (region?: string) => region === 'global' ? globalAccounts : workAccounts,
    routingAccounts: async (model: string, region?: string) => (region === 'global' ? globalAccounts : workAccounts).filter(account => !cooled.has(`${account.id}:${model}`)),
    acquireRoutingAccount: async (id: string, model: string, region?: string) => (region === 'global' ? globalAccounts : workAccounts).find(account => account.id === id && !cooled.has(`${id}:${model}`)),
    penalize: (id: string, _until: number, model: string) => cooled.add(`${id}:${model}`),
    noteServed: () => {}, expiryReadingOf: () => ({ stale: false }),
    unavailableReason: () => ({ reason: 'cooling', total: 2, cooling: 2 }),
  } as unknown as WorkBuddyAccountPool
  const client = {
    prepareChatBodyFor: (raw: string) => raw,
    chatStream: async (credential: { accessToken: string }, raw: string, signal: AbortSignal) => {
      const model = (JSON.parse(raw) as { model: string }).model
      const key = `wb:${credential.accessToken}:${model}`
      const onBlocked = blockOnce.get(key)
      if (onBlocked !== undefined) {
        blockOnce.delete(key)
        onBlocked()
        await new Promise<void>((_resolve, reject) => {
          if (signal.aborted) reject(new Error('aborted'))
          else signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
        })
      }
      if (failOnce.delete(key)) return { ok: false as const, kind: 'soft_rate' as const, status: 429, message: 'rate limited' }
      const failure = upstreamFailures.get(key)
      if (failure !== undefined) return failure
      served.push(key)
      return { ok: true as const, response: new Response(`data: {"choices":[{"delta":{"content":"${key}"}}]}\n\ndata: [DONE]\n\n`) }
    },
    fetchCredits: async () => { throw new Error('not needed') },
  } as unknown as WorkBuddyUpstreamClient
  const entries: ChannelAccountEntry[] = [{ id: 't1', enabled: true }, { id: 't2', enabled: true }]
  const hostPool: ChannelAccountPool = {
    listAccountsByProvider: provider => provider === 'trae' ? entries : [],
    getAvailableAccount: async (provider, _model, excluded) => {
      const entry = entries.find(item => !excluded?.has(item.id))
      return provider === 'trae' && entry !== undefined ? { entry, credential: {} } : null
    },
  }
  const accountRouting = createChannelAccountRouting(() => hostPool)
  const llm: ChannelLaneLlm = {
    listModels: async () => [{ id: 'x' }],
    stream: options => (async function* () {
      if (typeof options.sessionId === 'string') hostSessionIds.push(options.sessionId)
      const account = await hostPool.getAvailableAccount('trae', String(options.model))
      const key = `trae:${account?.entry.id}:${String(options.model)}`
      if (failOnce.delete(key)) {
        account!.entry.modelRateLimits = { [String(options.model)]: Date.now() + 60_000 }
        // Match a channel adapter that normally rotates to another account.
        await hostPool.getAvailableAccount('trae', String(options.model), new Set([account!.entry.id]))
      }
      served.push(key)
      yield { type: 'text-delta', index: 0, text: key }
      yield { type: 'finish', reason: { kind: 'stop' } }
    })(),
  }
  const channels = createChannelLane({ llm, providers: () => includeGlobal ? ['trae', 'xdpool-global'] : ['trae'], toId: (p, m) => `${p}:${m}` })
  const hosts = await channels.rows()
  const poolModels = ['x', 'y'].map(id => ({ id, name: id, contextWindow: 100_000, maxOutputTokens: 4096, supportsImages: false })) as WorkBuddyModelInfo[]
  const store = { version: 1 as const, combos: [{ name: 'test', models: ['x', 'trae:x', 'y', ...(includeGlobal ? ['xdpool-global:x'] : [])], strategy: 'round-robin' as const }] }
  const catalog = new AggregateCatalog(() => store, () => poolModels, () => hosts)
  await catalog.refresh()
  const poolCatalog = { current: () => poolModels, find: (id: string) => poolModels.find(model => model.id === id) } as unknown as WorkBuddyCatalog
  const shim = createWorkBuddyShim({ pool, client, catalog: poolCatalog, region: 'cn', aggregate: { catalog, readStore: () => store }, channels,
    channelAccountRouting: accountRouting, ...(path === undefined ? {} : { comboAffinityPath: path }) })
  shims.push(shim)
  await shim.ready
  async function ask(session: string, stream = false, signal?: AbortSignal) {
    const response = await fetch(`${shim.baseUrl()}/v1/chat/completions`, { method: 'POST',
      headers: { Authorization: `Bearer ${shim.token()}`, 'Content-Type': 'application/json', 'x-session-id': session },
      body: JSON.stringify({ model: 'combo:test', stream, messages: [{ role: 'user', content: 'hi' }] }),
      ...(signal === undefined ? {} : { signal }) })
    const body = await response.text()
    expect(response.status, body).toBe(200)
    return body
  }
  return { ask, served, cooled, failOnce, upstreamFailures, blockOnce, shim, hostSessionIds }
}

describe('least recently used account/model routes', () => {
  it('balances individual account/model combinations while a session stays pinned', async () => {
    const x = await setup()
    await x.ask('one')
    await x.ask('one')
    for (const session of ['two', 'three', 'four', 'five', 'six']) await x.ask(session)
    expect(x.served).toEqual(['wb:a:x', 'wb:a:x', 'trae:t1:x', 'wb:a:y', 'wb:b:x', 'trae:t2:x', 'wb:b:y'])
    await x.ask('one')
    expect(x.served.at(-1)).toBe('wb:a:x')
    await x.ask('seven')
    expect(x.served.at(-1)).toBe('trae:t1:x')
  })

  it('leaves a limited combination and selects the oldest remaining route', async () => {
    const x = await setup()
    await x.ask('one')
    x.failOnce.add('wb:a:x')
    await x.ask('one')
    expect(x.served).toEqual(['wb:a:x', 'trae:t1:x'])
    await x.ask('one')
    expect(x.served.at(-1)).toBe('trae:t1:x')
    // A cooldown for a:x does not suppress the same account's y model.
    await x.ask('other')
    await x.ask('other-2')
    expect(x.served.slice(-2)).toContain('wb:a:y')
  })

  it('prevents a channel adapter silently switching accounts after a limit', async () => {
    const x = await setup()
    await x.ask('first') // WorkBuddy a:x
    await x.ask('second') // TRAE t1:x
    x.failOnce.add('trae:t1:x')
    await x.ask('second')
    expect(x.served).toEqual(['wb:a:x', 'trae:t1:x', 'wb:a:y'])
    await x.ask('second')
    expect(x.served.at(-1)).toBe('wb:a:y')
  })

  it.each([
    [{ kind: 'client', status: 400, message: '{"code":11133,"msg":"private prompt and bearer secret","extError":{"param":"reasoning.effort"}}' }, { upstreamCode: '11133', upstreamParam: 'reasoning.effort' }],
    [{ kind: 'soft_rate', status: 429, message: '{"code":6004,"msg":"private prompt"}' }, { upstreamCode: '6004' }],
    [{ kind: 'server', status: 0, message: 'transport error: fetch failed', transport: 'timeout' }, { reason: 'timeout', status: 504, upstreamStatus: 0 }],
  ] as const)('records a sanitized upstream failure and its fallback for status $status', async (error, details) => {
    const dir = await mkdtemp(join(tmpdir(), 'xdpool-diagnostics-'))
    try {
      const path = join(dir, 'state.json')
      const x = await setup(path)
      x.upstreamFailures.set('wb:a:x', { ok: false, ...error })
      await x.ask('private-session')
      expect(x.served).toEqual(['trae:t1:x'])
      const log = await readFile(`${path}.events.jsonl`, 'utf8')
      const events = log.trim().split('\n').map(line => JSON.parse(line))
      expect(events[0]).toMatchObject({ requestId: expect.any(String), event: 'skip', status: error.status, member: 'x', ...details })
      expect(events[1]).toMatchObject({ requestId: events[0].requestId, event: 'result', outcome: 'recovered', member: 'trae:x', failures: 1 })
      expect(log).not.toMatch(/private prompt|bearer secret|private-session/)
      await x.shim.close()
    } finally { await rm(dir, { recursive: true, force: true }) }
  })

  it('sends a stable hashed session identity to the selected channel', async () => {
    const x = await setup()
    await x.ask('parent')
    await x.ask('child')
    await x.ask('child')
    expect(x.hostSessionIds).toHaveLength(2)
    expect(x.hostSessionIds[0]).toBe(x.hostSessionIds[1])
    expect(x.hostSessionIds[0]).not.toBe('child')
  })

  it('restores both account affinity and recency after restart', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'xdpool-lru-'))
    try {
      const file = join(dir, 'state.json')
      const first = await setup(file)
      await first.ask('one')
      await first.ask('two')
      expect(await readFile(`${file}.sqlite-wal`, 'utf8')).not.toContain('one')
      await first.shim.close()
      const next = await setup(file)
      await next.ask('one')
      await next.ask('new')
      expect(next.served).toEqual(['wb:a:x', 'wb:a:y'])
    } finally { await rm(dir, { recursive: true, force: true }) }
  })

  it('coordinates independent hosts sharing a data directory', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'xdpool-shared-'))
    try {
      const path = join(dir, 'state.json')
      const a = await setup(path), b = await setup(path)
      await Promise.all([a.ask('one'), b.ask('two')])
      expect(new Set([...a.served, ...b.served]).size).toBe(2)
      await b.ask('one')
      await a.ask('two')
      expect(b.served[1]).toBe(a.served[0])
      expect(a.served[1]).toBe(b.served[0])
      await Promise.all([a.ask('same'), b.ask('same')])
      expect(a.served[2]).toBe(b.served[2])
      await a.shim.close(); await b.shim.close()
      const next = await setup(path)
      await next.ask('one'); await next.ask('two'); await next.ask('same')
      expect(next.served).toEqual([a.served[0], b.served[0], a.served[2]])
    } finally { await rm(dir, { recursive: true, force: true }) }
  })

  it('releases cross-host waiters on cancellation without breaking the active session', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'xdpool-shared-cancel-'))
    try {
      const path = join(dir, 'state.json')
      const a = await setup(path), b = await setup(path)
      await a.ask('same')
      let started!: () => void
      const blocked = new Promise<void>(resolve => { started = resolve })
      a.blockOnce.set('wb:a:x', started)
      const active = new AbortController(), waiting = new AbortController()
      const first = a.ask('same', true, active.signal).catch(() => undefined)
      await blocked
      const second = b.ask('same', true, waiting.signal).catch(() => undefined)
      waiting.abort()
      await second
      active.abort()
      await first
      await b.ask('same')
      expect(b.served).toEqual(['wb:a:x'])
    } finally { await rm(dir, { recursive: true, force: true }) }
  })

  it('imports existing JSON bindings and usage when migrating', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'xdpool-migrate-'))
    try {
      const path = join(dir, 'state.json')
      const { createHash } = await import('node:crypto')
      const key = `combo:test:${createHash('sha256').update('old').digest('hex')}`
      await writeFile(path, JSON.stringify({ version: 2, bindings: { [key]: 'x' }, accounts: { [key]: 'b' }, lastUsed: { [JSON.stringify(['x', 'a'])]: 12 } }))
      const x = await setup(path)
      await x.ask('old')
      expect(x.served).toEqual(['wb:b:x'])
    } finally { await rm(dir, { recursive: true, force: true }) }
  })

  it('shares the provisional pin for concurrent requests in one session', async () => {
    const x = await setup()
    await Promise.all([x.ask('one'), x.ask('one'), x.ask('two')])
    expect(x.served.filter(value => value === 'wb:a:x')).toHaveLength(2)
    expect(x.served).toContain('trae:t1:x')
  })

  it.each([false, true])('coordinates simultaneous requests after a pinned account fails (stream=%s)', async stream => {
    const x = await setup()
    await x.ask('one', stream)
    x.failOnce.add('wb:a:x')
    await Promise.all([x.ask('one', stream), x.ask('one', stream)])
    expect(x.served).toEqual(['wb:a:x', 'trae:t1:x', 'trae:t1:x'])
  })

  it('releases the session when an in-flight request is cancelled', async () => {
    const x = await setup()
    await x.ask('one')
    let started!: () => void
    const blocked = new Promise<void>(resolve => { started = resolve })
    x.blockOnce.set('wb:a:x', started)
    const controller = new AbortController()
    const first = x.ask('one', true, controller.signal).catch(() => undefined)
    await blocked
    const next = x.ask('one')
    controller.abort()
    await first
    await next
    expect(x.served).toEqual(['wb:a:x', 'wb:a:x'])
  })

  it('uses the international pool account and bare model for global candidates', async () => {
    const x = await setup(undefined, true)
    for (const session of ['one', 'two', 'three', 'four']) await x.ask(session)
    expect(x.served).toEqual(['wb:a:x', 'trae:t1:x', 'wb:a:y', 'wb:g:x'])
    await x.ask('four')
    expect(x.served.at(-1)).toBe('wb:g:x')
  })
})
