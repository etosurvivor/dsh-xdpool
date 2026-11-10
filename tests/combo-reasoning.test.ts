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
