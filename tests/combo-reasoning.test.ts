import { afterEach, describe, expect, it, vi } from 'vitest'
import { AggregateCatalog } from '../src/aggregate.ts'
import { buildComboCatalog, resolveComboMember } from '../src/combos.ts'
import { createChannelLane, type ChannelLaneLlm } from '../src/channel-lane.ts'
import type { WorkBuddyModelInfo } from '../src/catalog.ts'
import { WorkBuddyCatalog } from '../src/catalog.ts'
import { createWorkBuddyShim } from '../src/shim.ts'
import { resolveMemberReasoningEffort, withMemberReasoningEffort } from '../src/reasoning.ts'
import type { WorkBuddyAccountPool } from '../src/accounts.ts'
import type { WorkBuddyUpstreamClient } from '../src/upstream.ts'

// The test drives this plugin's real descriptor builder; the host SDK is external.
vi.mock('@deepseek-ai/dsh-llm-pi-ai', () => ({ PiAiAdapter: class {} }))
vi.mock('@deepseek-ai/dsh-llm', () => ({ resolveImageAttachmentAccess: () => {}, resolveRetryPolicy: () => ({}) }))
vi.mock('@earendil-works/pi-ai', () => ({ createProvider: (input: unknown) => input }))
vi.mock('@earendil-works/pi-ai/api/openai-completions.lazy', () => ({ openAICompletionsApi: () => ({}) }))
import { createWorkBuddyAdapter } from '../src/adapter.ts'

const poolRow = (efforts?: readonly string[]): WorkBuddyModelInfo => ({
  id: 'deepseek-v4.1-flash', name: 'DeepSeek', contextWindow: 131072, maxOutputTokens: 8192, supportsImages: false,
  ...efforts === undefined ? {} : { supportedEfforts: efforts },
})
const chain = { name: 'test', models: ['deepseek-v4.1-flash', 'codearts/deepseek-v4.1-flash'] }
const hostRow = { id: 'codearts:deepseek-v4.1-flash', channel: 'codearts', modelId: 'deepseek-v4.1-flash', name: 'DeepSeek' }

describe('chain reasoning capabilities', () => {
  it('offers Low / High / Max and retains legacy channel IDs', () => {
    const [row] = buildComboCatalog([chain], { pool: [poolRow(['low', 'high', 'max'])], aggregate: [], host: [{ ...hostRow, supportedEfforts: ['high', 'max'] }] })
    expect(row?.supportedEfforts).toEqual(['low', 'high', 'max'])
    expect(row?.models).toEqual(['deepseek-v4.1-flash', hostRow.id])
    expect(resolveComboMember('codearts/codearts:deepseek-v4.1-flash', { pool: [], aggregate: [], host: [hostRow] })?.modelId).toBe(hostRow.id)
  })

  it('distinguishes unknown capability from a declared non-reasoning member', () => {
    const sources = { pool: [poolRow(['high'])], aggregate: [], host: [hostRow] }
    expect(buildComboCatalog([chain], sources)[0]?.supportedEfforts).toEqual(['low', 'high', 'max'])
    expect(buildComboCatalog([chain], { ...sources, host: [{ ...hostRow, supportedEfforts: [] }] })[0]?.supportedEfforts).toEqual(['low', 'high', 'max'])
    expect(buildComboCatalog([chain], { ...sources, pool: [poolRow()] })[0]?.supportedEfforts).toBeUndefined()
  })

  it('updates reasoning metadata even when every model ID stays unchanged', async () => {
    let efforts = ['high']
    const catalog = new AggregateCatalog(() => ({ version: 1, combos: [{ name: 'test', models: ['deepseek-v4.1-flash'] }] }), () => [poolRow(efforts)])
    const changed = vi.fn(); catalog.onChange(changed)
    await catalog.refresh()
    efforts = []; await catalog.refresh()
    expect(changed).toHaveBeenCalledTimes(2)
    efforts = ['high', 'max']; await catalog.refresh()
    const adapter = createWorkBuddyAdapter({ catalog, shim: { baseUrl: () => 'http://127.0.0.1', token: () => 'test' } as never, ctx: {} as never })
    expect(adapter.buildModels()[0]).toMatchObject({ reasoning: true, thinkingLevelMap: { low: 'low', high: 'high', max: 'max', medium: null }, compat: { supportsReasoningEffort: true } })
  })
})

const running: { close(): Promise<void> }[] = []
afterEach(async () => { while (running.length) await running.pop()!.close() })

describe('chain execution carries the selected effort to a host adapter', () => {
  it.each([['low', 'low'], ['high', 'high'], ['max', 'max'], ['max', 'high'], ['high', 'on'], ['max', 'on'], ['low', 'off']])('routes %s to native %s', async (requested, native) => {
    const seen: Record<string, unknown>[] = []
    const llm: ChannelLaneLlm = {
      listModels: async () => [{ id: hostRow.modelId }],
      resolveModelInfo: async () => ({ reasoning: { efforts: native === 'on' || native === 'off' ? [{ id: 'on' }, { id: 'off' }] : [{ id: native }] } }),
      stream: options => (async function* () { seen.push(options); yield { type: 'text-delta', text: 'OK' }; yield { type: 'finish', reason: { kind: 'stop' } } })(),
    }
    const channels = createChannelLane({ llm, providers: () => ['codearts'], toId: (channel, model) => `${channel}:${model}` })
    const hosts = await channels.rows()
    const store = { version: 1 as const, combos: [{ name: 'test', models: ['codearts/deepseek-v4.1-flash'] }] }
    const catalog = new AggregateCatalog(() => store, () => [], () => hosts)
    await catalog.refresh()
    expect(catalog.comboRows()[0]?.supportedEfforts).toEqual(['low', 'high', 'max'])
    const shim = createWorkBuddyShim({
      pool: { list: () => [], acquire: async () => undefined } as unknown as WorkBuddyAccountPool,
      client: {} as WorkBuddyUpstreamClient,
      catalog: new WorkBuddyCatalog(), aggregate: { catalog, readStore: () => store }, channels,
    })
    running.push(shim); await shim.ready
    const response = await fetch(`${shim.baseUrl()}/v1/chat/completions`, { method: 'POST', headers: { Authorization: `Bearer ${shim.token()}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ model: 'combo:test', messages: [{ role: 'user', content: 'test' }], reasoning_effort: requested }) })
    expect(response.status).toBe(200)
    expect(await response.text()).toContain('OK')
    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({ provider: 'codearts', model: hostRow.modelId, reasoningEffort: native })
  })

  it('downgrades unsupported Max to the model native High', async () => {
    const seen: Record<string, unknown>[] = []
    const stream = vi.fn(options => (async function* () { seen.push(options) })())
    const channels = createChannelLane({ llm: { listModels: async () => [], resolveModelInfo: async () => ({ reasoning: { efforts: [{ id: 'high' }] } }), stream }, providers: () => ['codearts'], toId: (c, m) => `${c}:${m}` })
    const turn = channels.turn({ channel: 'codearts', modelId: 'test', body: { reasoning_effort: 'max', messages: [] }, signal: new AbortController().signal })
    await turn.next()
    expect(seen[0]?.reasoningEffort).toBe('high')
  })
})

describe('per-member effort fallback', () => {
  it.each([
    ['max', ['high', 'xhigh'], 'high'],
    ['max', ['low', 'high'], 'high'],
    ['low', ['on', 'off'], 'off'],
    ['high', ['on', 'off'], 'on'],
    ['max', ['on', 'off'], 'on'],
    ['low', ['high', 'max'], 'high'],
    ['max', [], undefined],
  ])('maps %s against %j to %s', (requested, supported, expected) => {
    expect(resolveMemberReasoningEffort(requested as string, supported as string[])).toBe(expected)
  })

  it('does not carry a previous member downgrade into the next attempt', () => {
    const raw = JSON.stringify({ model: 'combo:test', reasoning_effort: 'max', messages: [] })
    expect(JSON.parse(withMemberReasoningEffort(raw, ['high'])).reasoning_effort).toBe('high')
    expect(JSON.parse(withMemberReasoningEffort(raw, ['high', 'max'])).reasoning_effort).toBe('max')
    expect(JSON.parse(withMemberReasoningEffort(raw, [])).reasoning_effort).toBeUndefined()
  })
})

describe('image routing through mixed host members', () => {
  it('rejects image requests when the live roster no longer has a capable member', async () => {
    const stream = vi.fn(() => (async function* () { yield { type: 'finish', reason: { kind: 'stop' } } })())
    const llm: ChannelLaneLlm = { listModels: async () => [{ id: 'text' }], resolveModelInfo: async () => ({ inputModalities: ['text'] }), stream }
    const channels = createChannelLane({ llm, providers: () => ['codearts'], toId: (c, m) => `${c}:${m}` })
    const hosts = await channels.rows()
    const store = { version: 1 as const, combos: [{ name: 'image', models: ['codearts/text'] }] }
    const catalog = new AggregateCatalog(() => store, () => [], () => hosts); await catalog.refresh()
    const shim = createWorkBuddyShim({ pool: { list: () => [], acquire: async () => undefined } as unknown as WorkBuddyAccountPool, client: {} as WorkBuddyUpstreamClient, catalog: new WorkBuddyCatalog(), aggregate: { catalog, readStore: () => store }, channels })
    running.push(shim); await shim.ready
    const response = await fetch(`${shim.baseUrl()}/v1/chat/completions`, { method: 'POST', headers: { Authorization: `Bearer ${shim.token()}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ model: 'combo:image', messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=' } }] }] }) })
    expect(response.status).toBe(400); expect(await response.text()).toContain('combo_no_image_member')
    expect(stream).not.toHaveBeenCalled()
  })

  it('skips text-only members, preserves the image, and retries a failed vision member', async () => {
    const seen: Record<string, unknown>[] = []
    const llm: ChannelLaneLlm = {
      listModels: async () => [{ id: 'text' }, { id: 'vision-bad' }, { id: 'vision-good' }],
      resolveModelInfo: async (_provider, id) => ({ inputModalities: id === 'text' ? ['text'] : ['text', 'image'] }),
      stream: options => (async function* () {
        seen.push(options)
        if (options.model === 'vision-bad') { yield { type: 'finish', reason: { kind: 'error', failure: { message: 'upstream failed' } } }; return }
        yield { type: 'text-delta', text: 'IMAGE_OK' }; yield { type: 'finish', reason: { kind: 'stop' } }
      })(),
    }
    const saved: Uint8Array[] = []
    const channels = createChannelLane({ llm, providers: () => ['codearts'], toId: (c, m) => `${c}:${m}`, attachments: () => ({ saveImage: async ({ data }) => { saved.push(data); return { id: 'test-image' } } }) })
    const hosts = await channels.rows()
    expect(hosts.map(row => row.supportsImages)).toEqual([false, true, true])
    const store = { version: 1 as const, combos: [{ name: 'image', models: ['codearts/text', 'codearts/vision-bad', 'codearts/vision-good'] }] }
    const catalog = new AggregateCatalog(() => store, () => [], () => hosts); await catalog.refresh()
    expect(catalog.comboRows()[0]?.supportsImages).toBe(true)
    const shim = createWorkBuddyShim({ pool: { list: () => [], acquire: async () => undefined } as unknown as WorkBuddyAccountPool, client: {} as WorkBuddyUpstreamClient, catalog: new WorkBuddyCatalog(), aggregate: { catalog, readStore: () => store }, channels })
    running.push(shim); await shim.ready
    const response = await fetch(`${shim.baseUrl()}/v1/chat/completions`, { method: 'POST', headers: { Authorization: `Bearer ${shim.token()}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ model: 'combo:image', messages: [{ role: 'user', content: [{ type: 'text', text: 'describe' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=' } }] }] }) })
    expect(response.status).toBe(200); expect(await response.text()).toContain('IMAGE_OK')
    expect(seen.map(call => call.model)).toEqual(['vision-bad', 'vision-good'])
    expect(saved).toHaveLength(2)
    for (const call of seen) expect(JSON.stringify(call.messages)).toContain('test-image')
  })
})

describe('saved route status compatibility', () => {
  it('normalizes legacy channel identifiers without marking reachable models missing', async () => {
    const { combosStatusOf } = await import('../src/index.ts')
    const host = [{ id: 'codearts:deepseek-v4.1-flash', channel: 'codearts', modelId: 'deepseek-v4.1-flash', name: 'Flash', supportedEfforts: ['high'], supportsImages: true }]
    const store = { version: 1 as const, combos: [{ name: 'test', models: ['codearts/codearts:deepseek-v4.1-flash', 'codearts:deepseek-v4.1-flash', 'codearts/missing'] }] }
    const catalog = new AggregateCatalog(() => store, () => [], () => host); await catalog.refresh()
    const status = combosStatusOf(store, catalog, [], host)
    expect(status.candidates.map(row => row.id)).toContain('codearts/deepseek-v4.1-flash')
    expect(status.combos[0]?.models).toEqual(['codearts/deepseek-v4.1-flash'])
    expect(status.combos[0]?.missing).toEqual(['codearts/missing'])
    expect(status.combos[0]?.platforms).toEqual([{ owner: 'codearts', models: ['deepseek-v4.1-flash'] }])
    expect(status.combos[0]?.supportsImages).toBe(true)
    const disabled = { ...store, combos: [{ ...store.combos[0]!, enabled: false }] }
    const disabledRow = combosStatusOf(disabled, catalog, [], host).combos[0]
    expect(disabledRow?.enabled).toBe(false)
    expect(disabledRow?.models).toEqual(['codearts/deepseek-v4.1-flash'])
  })
})

describe('route editor legacy restoration', () => {
  it('does not accumulate owner prefixes on repeated restores and saves', async () => {
    const { draftOf, flattenDraft } = await import('../src/client/RoutingPage.tsx')
    const initial = { id: 'combo:test', name: 'test', models: [], platforms: [], missing: ['codearts/codearts:deepseek-v4.1-flash', 'trae:deepseek-v4.1-flash'], strategy: 'fallback' as const, stickyLimit: 1, enabled: true, contextWindow: 1000, supportsImages: false }
    const draft = draftOf(initial)
    expect(draft.platforms).toEqual([{ owner: 'codearts', models: ['deepseek-v4.1-flash'] }, { owner: 'trae', models: ['deepseek-v4.1-flash'] }])
    const saved = flattenDraft(draft.platforms)
    expect(saved).toEqual(['codearts/deepseek-v4.1-flash', 'trae/deepseek-v4.1-flash'])
    expect(flattenDraft(draftOf({ ...initial, models: saved, platforms: draft.platforms, missing: [] }).platforms)).toEqual(saved)
  })
})

describe('routing context windows', () => {
  it('recalculates the actual chain after its smallest member is removed and saved', async () => {
    let store = { version: 1 as const, combos: [{ name: 'test', models: ['codearts/a', 'codearts/b', 'codearts/c'] }] }
    const hosts = [
      { id: 'codearts:a', channel: 'codearts', modelId: 'a', name: 'a', contextWindow: 1_000_000 },
      { id: 'codearts:b', channel: 'codearts', modelId: 'b', name: 'b', contextWindow: 400_000 },
      { id: 'codearts:c', channel: 'codearts', modelId: 'c', name: 'c', contextWindow: 1_048_576 },
    ]
    const catalog = new AggregateCatalog(() => store, () => [], () => hosts)
    await catalog.refresh(); expect(catalog.comboRows()[0]?.contextWindow).toBe(400_000)
    store = { ...store, combos: [{ name: 'test', models: ['codearts/a', 'codearts/c'] }] }
    await catalog.refresh(); expect(catalog.comboRows()[0]?.contextWindow).toBe(1_000_000)
    const adapter = createWorkBuddyAdapter({ catalog, shim: { baseUrl: () => 'http://127.0.0.1', token: () => 'test' } as never, ctx: {} as never })
    expect(adapter.buildModels()[0]?.contextWindow).toBe(1_000_000)
  })

  it('refuses an in-flight turn sized against a stale larger window', async () => {
    let now = Date.now(); let size = 400_000
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now)
    try {
      let hosts: Awaited<ReturnType<ReturnType<typeof createChannelLane>['rows']>> = []
      const store = { version: 1 as const, combos: [{ name: 'test', models: ['codearts/m'] }] }
      const catalog = new AggregateCatalog(() => store, () => [], () => hosts)
      const stream = vi.fn(() => (async function* () { yield { type: 'finish', reason: { kind: 'stop' } } })())
      const llm: ChannelLaneLlm = { listModels: async () => [{ id: 'm' }], resolveModelInfo: async () => ({ context: { contextWindow: size } }), stream }
      const channels = createChannelLane({ llm, providers: () => ['codearts'], toId: (c, m) => `${c}:${m}`, onRows: async rows => { hosts = rows; await catalog.refresh() } })
      await channels.rows(); expect(catalog.comboRows()[0]?.contextWindow).toBe(400_000)
      const shim = createWorkBuddyShim({ pool: { list: () => [], acquire: async () => undefined } as unknown as WorkBuddyAccountPool, client: {} as WorkBuddyUpstreamClient, catalog: new WorkBuddyCatalog(), aggregate: { catalog, readStore: () => store }, channels })
      running.push(shim); await shim.ready
      size = 200_000; now += 61_000
      const response = await fetch(`${shim.baseUrl()}/v1/chat/completions`, { method: 'POST', headers: { Authorization: `Bearer ${shim.token()}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ model: 'combo:test', messages: [{ role: 'user', content: 'test' }] }) })
      expect(response.status).toBe(400)
      expect(await response.text()).toContain('context_length_exceeded')
      expect(stream).not.toHaveBeenCalled()
      expect(catalog.comboRows()[0]?.contextWindow).toBe(200_000)
    } finally { clock.mockRestore() }
  })

  it('refreshes the chain when a live channel changes its declared window', async () => {
    vi.useFakeTimers()
    try {
      let windowSize = 400_000
      let hosts: Awaited<ReturnType<ReturnType<typeof createChannelLane>['rows']>> = []
      const store = { version: 1 as const, combos: [{ name: 'test', models: ['codearts/m'] }] }
      const catalog = new AggregateCatalog(() => store, () => [], () => hosts)
      const llm: ChannelLaneLlm = { listModels: async () => [{ id: 'm' }], resolveModelInfo: async () => ({ context: { contextWindow: windowSize } }), stream: () => (async function* () {})() }
      const lane = createChannelLane({ llm, providers: () => ['codearts'], toId: (c, m) => `${c}:${m}`, onRows: async rows => { hosts = rows; await catalog.refresh() } })
      await lane.rows()
      expect(catalog.comboRows()[0]?.contextWindow).toBe(400_000)
      windowSize = 200_000
      await vi.advanceTimersByTimeAsync(61_000)
      await lane.rows()
      expect(catalog.comboRows()[0]?.contextWindow).toBe(200_000)
    } finally {
      vi.useRealTimers()
    }
  })

  it('uses each channel declaration and the smallest resolved member window', async () => {
    let windows: Record<string, number | undefined> = { a: 1_000_000, b: 400_000 }
    const llm: ChannelLaneLlm = {
      listModels: async () => [{ id: 'a' }, { id: 'b' }],
      resolveModelInfo: async (_provider, id) => ({ context: windows[id] === undefined ? {} : { contextWindow: windows[id] } }),
      stream: () => (async function* () {})(),
    }
    const makeChannels = () => createChannelLane({ llm, providers: () => ['codearts'], toId: (c, m) => `${c}:${m}` })
    let hosts = await makeChannels().rows()
    expect(hosts.map(row => row.contextWindow)).toEqual([1_000_000, 400_000])
    const store = { version: 1 as const, combos: [{ name: 'test', models: ['codearts/a', 'codearts/b'] }] }
    const catalog = new AggregateCatalog(() => store, () => [], () => hosts)
    await catalog.refresh()
    expect(catalog.comboRows()[0]?.contextWindow).toBe(400_000)
    const { combosStatusOf } = await import('../src/index.ts')
    expect(combosStatusOf(store, catalog, [], hosts).candidates.map(row => row.contextWindow)).toEqual([1_000_000, 400_000])
    const adapter = createWorkBuddyAdapter({ catalog, shim: { baseUrl: () => 'http://127.0.0.1', token: () => 'test' } as never, ctx: {} as never })
    expect(adapter.buildModels()[0]?.contextWindow).toBe(400_000)
    windows = { a: 1_000_000, b: 200_000 }; hosts = await makeChannels().rows(); await catalog.refresh()
    expect(catalog.comboRows()[0]?.contextWindow).toBe(200_000)
    windows = { a: 1_000_000, b: undefined }; hosts = await makeChannels().rows(); await catalog.refresh()
    expect(catalog.comboRows()[0]?.contextWindow).toBe(131_072)
  })

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])('rejects invalid window %s', async value => {
    const llm: ChannelLaneLlm = { listModels: async () => [{ id: 'm' }], resolveModelInfo: async () => ({ context: { contextWindow: value } }), stream: () => (async function* () {})() }
    const hosts = await createChannelLane({ llm, providers: () => ['codearts'], toId: (c, m) => `${c}:${m}` }).rows()
    expect(hosts[0]?.contextWindow).toBeUndefined()
    expect(resolveComboMember('codearts/m', { pool: [], aggregate: [], host: hosts })?.contextWindow).toBe(131_072)
  })
})
