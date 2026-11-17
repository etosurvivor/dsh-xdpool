import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AggregateCatalog } from '../src/aggregate.ts'
import { WorkBuddyCatalog } from '../src/catalog.ts'
import { createChannelLane, type ChannelLaneLlm } from '../src/channel-lane.ts'
import { resetComboRotation } from '../src/combos.ts'
import { createWorkBuddyShim } from '../src/shim.ts'
import { createWorkBuddyAdapter } from '../src/adapter.ts'
import { UsageRecorder } from '../src/stats.ts'
import type { WorkBuddyAccountPool } from '../src/accounts.ts'
import type { WorkBuddyUpstreamClient } from '../src/upstream.ts'

const running: { close(): Promise<void> }[] = []
afterEach(async () => { while (running.length > 0) await running.pop()!.close(); resetComboRotation() })

async function gateway(models: Record<string, string[]>, members: string[], failed: Set<string>, served: string[], opts: { path?: string; strategy?: 'round-robin' | 'fallback'; parents?: Record<string, string>; usage?: UsageRecorder; transient?: Map<string, number> } = {}) {
  const llm: ChannelLaneLlm = {
    listModels: async provider => (models[provider] ?? []).map(id => ({ id })),
    stream: options => (async function* () {
      const id = `${String(options.provider)}:${String(options.model)}`
      const transient = opts.transient?.get(id) ?? 0
      if (transient > 0) {
        opts.transient?.set(id, transient - 1)
        throw new Error('fetch failed: ECONNRESET')
      }
      if (failed.has(id)) {
        yield { type: 'finish', reason: { kind: 'error', failure: { message: 'temporarily unavailable' } } }
        return
      }
      served.push(id)
      yield { type: 'text-delta', index: 0, text: id }
      yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 4, cacheReadTokens: 3, reasoningTokens: 2 } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    })(),
  }
  const channels = createChannelLane({ llm, providers: () => Object.keys(models), toId: (c, m) => `${c}:${m}` })
  let host = await channels.rows()
  const store = { version: 1 as const, combos: [{ name: 'balanced', models: members, strategy: opts.strategy ?? 'round-robin' as const, stickyLimit: 1 }] }
  const catalog = new AggregateCatalog(() => store, () => [], () => host)
  await catalog.refresh()
  const pool = { list: () => [], acquire: async () => undefined } as unknown as WorkBuddyAccountPool
  const shim = createWorkBuddyShim({ pool, client: {} as WorkBuddyUpstreamClient, catalog: new WorkBuddyCatalog('cn'), aggregate: { catalog, readStore: () => store }, channels, ...(opts.path === undefined ? {} : { comboAffinityPath: opts.path }), ...(opts.parents === undefined ? {} : { parentSessionOf: (session: string) => opts.parents?.[session] }), ...(opts.usage === undefined ? {} : { usageRecorder: opts.usage }) })
  running.push(shim)
  await shim.ready
  const call = async (stream: boolean, session?: string) => {
    const response = await fetch(`${shim.baseUrl()}/v1/chat/completions`, {
      method: 'POST', headers: { Authorization: `Bearer ${shim.token()}`, 'Content-Type': 'application/json', ...(session === undefined ? {} : { 'x-session-id': session }) },
      body: JSON.stringify({ model: 'combo:balanced', stream, messages: [{ role: 'user', content: 'test' }] }),
    })
    const body = await response.text()
    expect(response.status, body).toBe(200)
    return body
  }
  const refresh = async () => { channels.invalidateAll(); host = await channels.rows(); await catalog.refresh() }
  return Object.assign(call, { shim, catalog, refresh })
}

describe('balanced route members', () => {
  it.each([true, false])('counts and forwards actual usage for main and child sessions (stream=%s)', async stream => {
    const usage = new UsageRecorder()
    const served: string[] = []
    const call = await gateway({ one: ['a', 'b'] }, ['one:a', 'one:b'], new Set(), served, { usage, parents: { child: 'parent' } })
    const parent = await call(stream, 'parent')
    const child = await call(stream, 'child')
    expect(parent).toContain('prompt_tokens')
    expect(child).toContain('completion_tokens')
    const summary = usage.summary()
    expect(summary.calls).toBe(2)
    expect(summary.rows.map(row => [row.model, row.inputTokens, row.outputTokens, row.cachedTokens, row.reasoningTokens]).sort())
      .toEqual([['a', 13, 4, 3, 2], ['b', 13, 4, 3, 2]])
  })
  it('keeps a configured session member when its catalog temporarily disappears', async () => {
    const served: string[] = []
    const models = { one: ['a'], two: ['b'] }
    const call = await gateway(models, ['one:a', 'two:b'], new Set(), served)
    await call(false, 'parent')
    models.one = []
    await call.refresh()
    await call(false, 'parent')
    models.one = ['a']
    await call.refresh()
    await call(false, 'parent')
    expect(served).toEqual(['one:a', 'one:a', 'one:a'])
  })
  it('retries a transient failure on the pinned member and records a private diagnostic', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'xdpool-route-retry-'))
    try {
      const path = join(dir, 'affinity.json')
      const usage = new UsageRecorder()
      const served: string[] = []
      const transient = new Map<string, number>()
      const call = await gateway({ one: ['a', 'b'] }, ['one:a', 'one:b'], new Set(), served, { path, usage, transient })
      await call(false, 'private-session')
      transient.set('one:a', 1)
      await call(false, 'private-session')
      expect(served).toEqual(['one:a', 'one:a'])
      expect(usage.summary().calls).toBe(3)
      const trace = await readFile(`${path}.events.jsonl`, 'utf8')
      expect(trace).toContain('"event":"retry"')
      expect(trace).not.toContain('private-session')
    } finally { await rm(dir, { recursive: true, force: true }) }
  })
  it('keeps the persisted binding through a missing catalog at startup', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'xdpool-route-missing-'))
    try {
      const path = join(dir, 'affinity.json')
      const served: string[] = []
      const models = { one: ['a'], two: ['b'] }
      const first = await gateway(models, ['one:a', 'two:b'], new Set(), served, { path })
      await first(false, 'parent')
      await first.shim.close()
      resetComboRotation()
      models.one = []
      const second = await gateway(models, ['one:a', 'two:b'], new Set(), served, { path })
      await second(false, 'parent')
      models.one = ['a']
      await second.refresh()
      await second(false, 'parent')
      expect(served).toEqual(['one:a', 'two:b', 'one:a'])
    } finally { await rm(dir, { recursive: true, force: true }) }
  })
  it('clears a binding when the user actually removes its member', async () => {
    const served: string[] = []
    const members = ['one:a', 'two:b']
    const call = await gateway({ one: ['a'], two: ['b'] }, members, new Set(), served)
    await call(false, 'parent')
    members.shift()
    await call.refresh()
    await call(false, 'parent')
    expect(served).toEqual(['one:a', 'two:b'])
  })
  it('routes a global WorkBuddy member to its own host provider and reports its region', async () => {
    const served: string[] = []
    const call = await gateway({ 'xdpool-global': ['deepseek-v4.1-flash'] }, ['xdpool-global:deepseek-v4.1-flash'], new Set(), served)
    await call(false, 'global-task')
    expect(served).toEqual(['xdpool-global:deepseek-v4.1-flash'])
    expect(await call.shim.routeLastUsed('global-task', 'combo:balanced')).toEqual({ channel: 'WorkBuddy 国际版', model: 'deepseek-v4.1-flash' })
  })
  it('reports the last successful channel and model for the requested session only', async () => {
    const served: string[] = []
    const failed = new Set<string>()
    const call = await gateway({ trae: ['flash'], loomy: ['flash'] }, ['trae:flash', 'loomy:flash'], failed, served)
    expect(await call.shim.routeLastUsed('parent', 'combo:balanced')).toBeUndefined()
    await call(false, 'parent')
    await call(false, 'other')
    expect(await call.shim.routeLastUsed('parent', 'combo:balanced')).toEqual({ channel: 'TRAE', model: 'flash' })
    expect(await call.shim.routeLastUsed('other', 'combo:balanced')).toEqual({ channel: 'Loomy', model: 'flash' })
    expect(await call.shim.routeLastUsed('parent', 'combo:other')).toBeUndefined()
    failed.add('trae:flash')
    await call(false, 'parent')
    expect(await call.shim.routeLastUsed('parent', 'combo:balanced')).toEqual({ channel: 'Loomy', model: 'flash' })
  })
  it('keeps the parent fixed while children spread across other model members', async () => {
    const served: string[] = []
    const parents = { child1: 'parent', child2: 'parent', child3: 'parent' }
    const call = await gateway({ one: ['a', 'b'], two: ['c'] }, ['one:a', 'one:b', 'two:c'], new Set(), served, { parents })
    for (const session of ['parent', 'child1', 'child2', 'child3', 'parent', 'child1']) await call(false, session)
    expect(served).toEqual(['one:a', 'one:b', 'two:c', 'one:b', 'one:a', 'one:b'])
  })

  it('tries another non-parent model on child failure and keeps parent as last resort', async () => {
    const served: string[] = []
    const failed = new Set<string>()
    const call = await gateway({ one: ['a', 'b'], two: ['c'] }, ['one:a', 'one:b', 'two:c'], failed, served, { parents: { child: 'parent' } })
    await call(false, 'parent')
    await call(false, 'child')
    failed.add('one:b')
    await call(false, 'child')
    failed.add('two:c')
    await call(false, 'child')
    expect(served).toEqual(['one:a', 'one:b', 'two:c', 'one:a'])
  })
  it('restores the selected model after a restart without storing session text', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'xdpool-affinity-test-'))
    try {
      const path = join(dir, 'affinity.json')
      const served: string[] = []
      const first = await gateway({ one: ['a', 'b'] }, ['one:a', 'one:b'], new Set(), served, { path })
      await first(false, 'private-session-a')
      await first(false, 'private-session-b')
      expect(await readFile(`${path}.sqlite-wal`, 'utf8')).not.toContain('private-session')
      await first.shim.close()
      resetComboRotation()
      const second = await gateway({ one: ['a', 'b'] }, ['one:a', 'one:b'], new Set(), served, { path })
      await second(false, 'private-session-b')
      expect(served).toEqual(['one:a', 'one:b', 'one:b'])
    } finally { await rm(dir, { recursive: true, force: true }) }
  })

  it('keeps the explicit fallback strategy in priority order', async () => {
    const served: string[] = []
    const call = await gateway({ one: ['a', 'b'] }, ['one:a', 'one:b'], new Set(), served, { strategy: 'fallback' })
    await call(false, 'task-a')
    await call(false, 'task-b')
    expect(served).toEqual(['one:a', 'one:a'])
  })
  it('passes the real DSH adapter session id through pi-ai to the gateway', async () => {
    const served: string[] = []
    const gatewayCall = await gateway({ one: ['a', 'b'], two: ['c'] }, ['one:a', 'one:b', 'two:c'], new Set(), served)
    const adapter = createWorkBuddyAdapter({ shim: gatewayCall.shim, catalog: gatewayCall.catalog, ctx: { get: () => undefined } as never, providerId: 'xdpool-aggregate' }).adapter
    const ask = async (session: string) => {
      const chunks = []
      for await (const chunk of adapter.stream({ provider: 'xdpool-aggregate', model: 'combo:balanced', sessionId: session as never, messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }] as never })) chunks.push(chunk)
      expect(chunks.some(chunk => chunk.type === 'finish' && chunk.reason.kind === 'stop')).toBe(true)
      expect(chunks.some(chunk => chunk.type === 'usage' && chunk.usage.outputTokens === 4)).toBe(true)
    }
    await ask('session-a')
    await ask('session-a')
    await ask('session-b')
    expect(served).toEqual(['one:a', 'one:a', 'one:b'])
  })
  it.each([true, false])('pins a task and balances new tasks by model rather than provider (stream=%s)', async stream => {
    const served: string[] = []
    const call = await gateway({ one: ['a', 'b'], two: ['c'] }, ['one:a', 'one:b', 'two:c'], new Set(), served)
    await call(stream, 'task-a')
    await call(stream, 'task-a')
    await call(stream, 'task-b')
    await call(stream, 'task-b')
    await call(stream, 'task-c')
    await call(stream, 'task-a')
    expect(served).toEqual(['one:a', 'one:a', 'one:b', 'one:b', 'two:c', 'one:a'])
  })

  it.each([true, false])('rebinds an existing task after its member fails (stream=%s)', async stream => {
    const served: string[] = []
    const failed = new Set<string>()
    const call = await gateway({ one: ['a', 'b'], two: ['c'] }, ['one:a', 'one:b', 'two:c'], failed, served)
    await call(stream, 'task-a')
    failed.add('one:a')
    await call(stream, 'task-a')
    failed.clear()
    await call(stream, 'task-a')
    expect(served).toEqual(['one:a', 'one:b', 'one:b'])
  })

  it('keeps concurrent requests from the same task on the same member', async () => {
    const served: string[] = []
    const call = await gateway({ one: ['a', 'b'], two: ['c'] }, ['one:a', 'one:b', 'two:c'], new Set(), served)
    await Promise.all([call(false, 'task-a'), call(false, 'task-a'), call(false, 'task-a')])
    await call(false, 'task-b')
    expect(served).toEqual(['one:a', 'one:a', 'one:a', 'one:b'])
  })
  it.each([true, false])('rotates each model member, not each provider (stream=%s)', async stream => {
    const served: string[] = []
    const call = await gateway({ one: ['a', 'b'], two: ['c'] }, ['one:a', 'one:b', 'two:c'], new Set(), served)
    for (let n = 0; n < 6; n++) await call(stream)
    expect(served).toEqual(['one:a', 'one:b', 'two:c', 'one:a', 'one:b', 'two:c'])
  })

  it.each([true, false])('balances working members after a failure and rejoins the recovered member (stream=%s)', async stream => {
    const served: string[] = []
    const failed = new Set(['one:a'])
    const call = await gateway({ one: ['a', 'b'], two: ['c'] }, ['one:a', 'one:b', 'two:c'], failed, served)
    for (let n = 0; n < 6; n++) await call(stream)
    expect(served).toEqual(['one:b', 'two:c', 'one:b', 'two:c', 'one:b', 'two:c'])
    failed.clear()
    for (let n = 0; n < 3; n++) await call(stream)
    expect(served.slice(6)).toEqual(['one:a', 'one:b', 'two:c'])
  })

  it('keeps successful members close under concurrent starts while one member fails', async () => {
    const served: string[] = []
    const call = await gateway({ one: ['a', 'b'], two: ['c'] }, ['one:a', 'one:b', 'two:c'], new Set(['one:a']), served)
    for (let n = 0; n < 12; n++) await Promise.all([call(false), call(false), call(false)])
    const b = served.filter(id => id === 'one:b').length
    const c = served.filter(id => id === 'two:c').length
    expect(b + c).toBe(36)
    expect(Math.abs(b - c)).toBeLessThanOrEqual(2)
  })
})
