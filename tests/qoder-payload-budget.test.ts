import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
const pack = readFileSync(new URL('../vendor/channel-pack/pack.js', import.meta.url), 'utf8')
const start = pack.indexOf('const QODER_PAYLOAD_BYTE_BUDGET')
const end = pack.indexOf('async function getGlue()', start)
if (start < 0 || end < 0) throw new Error('Qoder payload helper missing')
class StubLlmError extends Error { constructor(message: string, readonly code: string) { super(message) } }
const fit = new Function('Buffer', 'LlmError5', `${pack.slice(start, end)}; return fitQoderPayload`)(Buffer, StubLlmError) as (payload: any) => any

describe('Qoder WASM payload budget', () => {
  it('drops complete old turns while preserving system, tools, and latest tool cycle', () => {
    const system = [{ type: 'text', text: 'system instructions' }]
    const tools = [{ function: { name: 'shell', description: 'must keep', parameters: { type: 'object' } } }]
    const messages = [
      { role: 'user', content: 'old' }, { role: 'assistant', content: 'x'.repeat(720000) },
      { role: 'user', content: 'latest' }, { role: 'assistant', content: '', tool_calls: [{ id: 'x' }] },
      { role: 'tool', content: 'result', tool_call_id: 'x' },
    ]
    const original = { system, tools, messages }
    const result = fit(original)
    expect(result.messages).toEqual(messages.slice(2))
    expect(result.system).toEqual(system); expect(result.tools).toEqual(tools)
    expect(original.messages).toHaveLength(5)
  })
  it('fails explicitly instead of truncating the only current turn', () => {
    const payload = { messages: [{ role: 'user', content: 'z'.repeat(720000) }], tools: [] }
    expect(() => fit(payload)).toThrow(/压缩上下文/)
  })
  it('does not alter small requests', () => {
    const payload = { messages: [{ role: 'user', content: 'hello' }], tools: [] }
    expect(fit(payload)).toBe(payload)
  })
})
