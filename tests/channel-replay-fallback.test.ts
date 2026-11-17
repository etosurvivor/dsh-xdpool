import { afterEach, describe, expect, it } from 'vitest'
import { LlmRuntime } from '@deepseek-ai/dsh-llm'
import { AggregateCatalog } from '../src/aggregate.ts'
import { WorkBuddyCatalog } from '../src/catalog.ts'
import { createChannelLane, type ChannelLaneLlm } from '../src/channel-lane.ts'
import { createWorkBuddyShim } from '../src/shim.ts'
import type { WorkBuddyAccountPool } from '../src/accounts.ts'
import type { WorkBuddyUpstreamClient } from '../src/upstream.ts'

const running: { close(): Promise<void> }[] = []
afterEach(async () => { while (running.length > 0) await running.pop()!.close() })

/** Exercise the actual DSH runtime's replay-ownership check at the host seam. */
function replayCheckingLlm(seen: Record<string, unknown>[]): ChannelLaneLlm {
  const host = { adapters: new Map() }
  const adapter = {}
  const check = (LlmRuntime.prototype as unknown as { forAdapter: (options: unknown, adapter: unknown) => unknown }).forAdapter
  return {
    listModels: async () => [{ id: 'M' }],
    stream: options => (async function* () {
      check.call(host, options, adapter)
      seen.push(options)
      yield { type: 'text-delta', index: 0, text: 'FALLBACK_OK' }
      yield { type: 'finish', reason: { kind: 'stop' } }
    })(),
  }
}

async function fallbackGateway(seen: Record<string, unknown>[]) {
  const poolCatalog = new WorkBuddyCatalog('cn')
  const poolModel = poolCatalog.current()[0]!.id
  const channels = createChannelLane({ llm: replayCheckingLlm(seen), providers: () => ['trae'], toId: (c, m) => `${c}:${m}` })
  const host = await channels.rows()
  const store = { version: 1 as const, combos: [{ name: 'fallback', models: [poolModel, 'trae:M'] }] }
  const catalog = new AggregateCatalog(() => store, () => poolCatalog.current(), () => host)
  await catalog.refresh()
  const pool = {
    list: () => [], acquire: async () => undefined,
    unavailableReason: () => ({ total: 1, cooling: 1, disabled: 0, dead: 0, reason: 'cooling' }),
  } as unknown as WorkBuddyAccountPool
  const shim = createWorkBuddyShim({ pool, client: {} as WorkBuddyUpstreamClient, catalog: poolCatalog, aggregate: { catalog, readStore: () => store }, channels })
  running.push(shim)
  await shim.ready
  return async (messages: unknown[]) => {
    const response = await fetch(`${shim.baseUrl()}/v1/chat/completions`, {
      method: 'POST', headers: { Authorization: `Bearer ${shim.token()}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'combo:fallback', stream: false, messages }),
    })
    return { status: response.status, text: await response.text() }
  }
}

describe('channel fallback with durable conversation history', () => {
  it('passes DSH replay ownership checks when WorkBuddy is cooling', async () => {
    const seen: Record<string, unknown>[] = []
    const call = await fallbackGateway(seen)
    const result = await call([{ role: 'user', content: 'first' }, { role: 'assistant', content: 'previous reply' }, { role: 'user', content: 'continue' }])
    expect(result.status, result.text).toBe(200)
    expect(result.text).toContain('FALLBACK_OK')
    const messages = seen[0]!.messages as Record<string, unknown>[]
    expect(messages[1]).toMatchObject({ role: 'assistant', source: { kind: 'model', provider: 'trae', model: 'M' } })
    expect(messages.every(message => typeof message.id === 'string' && message.source !== undefined)).toBe(true)
  })

  it('preserves assistant tool calls and their matching tool results on the fallback', async () => {
    const seen: Record<string, unknown>[] = []
    const call = await fallbackGateway(seen)
    const result = await call([
      { role: 'user', content: 'read it' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'read', arguments: '{"path":"a.txt"}' } }] },
      { role: 'tool', tool_call_id: 'call_1', content: 'contents' },
      { role: 'user', content: 'continue' },
    ])
    expect(result.status, result.text).toBe(200)
    const messages = seen[0]!.messages as Record<string, unknown>[]
    expect(messages[1]).toMatchObject({ role: 'assistant', content: [{ type: 'tool-call', id: 'call_1', name: 'read', arguments: '{"path":"a.txt"}' }] })
    expect(messages[2]).toMatchObject({ role: 'tool', toolCallId: 'call_1', source: { kind: 'tool', callId: 'call_1' }, content: [{ type: 'text', text: 'contents' }] })
  })
})
