import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm/types'
import type { DoubaoSession } from '../src/doubao-auth.ts'

const fake = vi.hoisted(() => ({ reply: '', request: undefined as Record<string, unknown> | undefined }))
vi.mock('../src/doubao-llm.ts', () => ({
  createDoubaoLlm: () => ({
    stream: async function* (options: Record<string, unknown>) {
      fake.request = options
      yield { type: 'text-delta', text: fake.reply }
    },
  }),
}))
import { DoubaoAdapter, DOUBAO_PROVIDER_ID } from '../src/doubao-adapter.ts'

const session: DoubaoSession = { cookies: { sessionid: 'test' }, userAgent: 'test', savedAt: '2026-01-01' }
const options = (extra: Record<string, unknown> = {}) => ({
  provider: DOUBAO_PROVIDER_ID,
  model: '3',
  messages: [{ role: 'user', content: [{ type: 'text', text: '运行 pwd' }] }],
  ...extra,
}) as unknown as GenerateOptions
async function collect(adapter: DoubaoAdapter, opts: GenerateOptions) {
  const chunks = []
  for await (const chunk of adapter.stream(opts)) chunks.push(chunk)
  return chunks
}

describe('豆包直接对话适配', () => {
  beforeEach(() => { fake.reply = ''; fake.request = undefined })
  it('only exposes direct conversation models for a signed-in account', async () => {
    expect(await new DoubaoAdapter(() => undefined).listModels()).toEqual([])
    expect((await new DoubaoAdapter(() => session).listModels()).map(row => row.id)).toEqual(['0', '3'])
  })
  it('shows enabled work models and dispatches them in work mode', async () => {
    const catalog = () => [
      { id: '0', name: '快速', mode: 'chat' as const },
      { id: 'person-deepseek', name: 'DeepSeek', mode: 'work' as const, reasoning: [{ level: 3, name: '低' }, { level: 7, name: '最高' }] },
    ]
    const adapter = new DoubaoAdapter(() => session, { ready: Promise.resolve(), store: { isEnabled: id => id !== '0' }, catalog })
    expect((await adapter.listModels()).map(row => row.id)).toEqual(['person-deepseek'])
    expect((await adapter.resolveModel(DOUBAO_PROVIDER_ID, '0')).name).toBe('快速')
    expect((await adapter.resolveModel(DOUBAO_PROVIDER_ID, 'person-deepseek')).reasoning?.efforts.map(x => x.id)).toEqual(['low', 'max'])
    fake.reply = 'OK'
    await collect(adapter, options({ model: 'person-deepseek' }))
    expect(fake.request).toMatchObject({ taskMode: true, model: 'person-deepseek' })
    await expect(adapter.resolveModel(DOUBAO_PROVIDER_ID, 'unknown')).rejects.toThrow('不存在')
  })
  it('emits a complete text block', async () => {
    fake.reply = '你好'
    const chunks = await collect(new DoubaoAdapter(() => session), options())
    expect(chunks.map(chunk => chunk.type)).toEqual(['block-start', 'text-delta', 'block-end', 'finish'])
    expect(chunks.at(-1)).toMatchObject({ reason: { kind: 'stop' } })
  })
  it('translates a declared tool call into host blocks without executing it', async () => {
    fake.reply = '{"tool_calls":[{"name":"shell","arguments":{"command":"pwd"}}]}'
    const chunks = await collect(new DoubaoAdapter(() => session), options({ tools: [{ name: 'shell', parameters: { type: 'object' } }] }))
    expect(chunks.find(chunk => chunk.type === 'tool-call-delta')).toMatchObject({ name: 'shell', argumentsDelta: '{"command":"pwd"}' })
    expect(chunks.at(-1)).toMatchObject({ reason: { kind: 'tool-calls' } })
    expect(JSON.stringify(fake.request?.messages)).toContain('不能自己执行')
  })
  it('rejects undeclared tool names', async () => {
    fake.reply = '{"tool_calls":[{"name":"other","arguments":{}}]}'
    const chunks = await collect(new DoubaoAdapter(() => session), options({ tools: [{ name: 'shell', parameters: { type: 'object' } }] }))
    expect(chunks.at(-1)).toMatchObject({ reason: { kind: 'error', failure: { code: 'DOUBAO_ERROR' } } })
    expect(chunks.some(chunk => chunk.type === 'tool-call-delta')).toBe(false)
  })
})
