import { afterEach, describe, expect, it, vi } from 'vitest'
import { DOUBAO_WORK_MODEL, doubaoChatBody, parseDoubaoSse } from '../src/doubao-work-direct.ts'
import { decodeDoubaoToolResponse, DoubaoWorkAdapter, DOUBAO_WORK_PROVIDER } from '../src/doubao-work-adapter.ts'

afterEach(() => vi.unstubAllGlobals())

describe('Doubao Work direct protocol', () => {
  it('requests the one configured model in each client field', () => {
    const body = doubaoChatBody('hello', 'bot') as any
    expect(body.option.model_config.model_item_key).toBe(DOUBAO_WORK_MODEL)
    expect(body.option.conversation_init_ext.model_item_key).toBe(DOUBAO_WORK_MODEL)
    expect(body.option.aggregate_params.model_item_key).toBe(DOUBAO_WORK_MODEL)
    expect(body.option.agent_mode).toBe(2)
    expect(body.option.general_task_param).toBeUndefined()
  })
  it('extracts assistant output without leaking the user echo', () => {
    const frame = (event: string, value: unknown) => `event: ${event}\ndata: ${JSON.stringify(value)}\n\n`
    const block = (text: string) => ({ block_type: 10000, block_id: 'a', content: { text_block: { text } } })
    const input = frame('FULL_MSG_NOTIFY', { message: { user_type: 1, content_block: [block('secret user prompt')] } })
      + frame('STREAM_MSG_NOTIFY', { meta: { user_type: 2 }, content: { content_block: [block('O')] } })
      + frame('STREAM_CHUNK', { patch_op: [{ patch_object: 1, patch_type: 1, patch_value: { content_block: [block('K')] } }] })
      + frame('SSE_REPLY_END', {})
    expect(parseDoubaoSse(input)).toBe('OK')
    expect(() => parseDoubaoSse(input.replace('SSE_REPLY_END', 'OTHER'))).toThrow(/不完整/u)
  })
  it('preserves chunk deltas after the initial text block', () => {
    const input = 'event: STREAM_MSG_NOTIFY\ndata: {"meta":{"user_type":2},"content":{"content_block":[{"block_type":10000,"block_id":"a","content":{"text_block":{"text":"he"}}}]}}\n\n'
      + 'event: CHUNK_DELTA\ndata: {"text":"llo"}\n\n' + 'event: SSE_REPLY_END\ndata: {}\n\n'
    expect(parseDoubaoSse(input)).toBe('hello')
  })
  it('rejects undeclared or malformed tools rather than executing them', () => {
    const tools = [{ name: 'read_file', description: '', parameters: {} }]
    expect(decodeDoubaoToolResponse('{"tool_calls":[{"name":"read_file","arguments":{"path":"x"}}]}', tools).calls?.[0]).toEqual({ name: 'read_file', arguments: '{"path":"x"}' })
    expect(() => decodeDoubaoToolResponse('{"tool_calls":[{"name":"run_command","arguments":{}}]}', tools)).toThrow(/未声明/u)
    expect(() => decodeDoubaoToolResponse('{"tool_calls":[{"name":"read_file","arguments":"x"}]}', tools)).toThrow(/参数/u)
  })
  it('returns a DSH tool call and accepts the real tool result on the next request', async () => {
    const frame = (event: string, data: unknown) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
    let calls = 0
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).includes('/alice/user/launch')) return new Response(JSON.stringify({ code: 0, data: { assistant_bot_id: 'bot' } }), { status: 200 })
      const body = JSON.parse(String(init?.body))
      const input = JSON.parse(body.messages[0].content_block[0].content.text_block.text)
      calls++
      if (calls === 2) expect(input.history.at(-1).content[0].text).toBe('/tmp/test')
      const output = calls === 1 ? '{"tool_calls":[{"name":"bash","arguments":{"command":"pwd","description":"Check working directory"}}]}' : '{"answer":"/tmp/test"}'
      const block = { block_id: 'a', block_type: 10000, content: { text_block: { text: output } } }
      return new Response(frame('STREAM_MSG_NOTIFY', { meta: { user_type: 2 }, content: { content_block: [block] } }) + frame('SSE_REPLY_END', {}), { status: 200 })
    }))
    const adapter = new DoubaoWorkAdapter(async () => ({ cookieHeader: 'sessionid=example', deviceId: '123' }))
    const options = { provider: DOUBAO_WORK_PROVIDER, model: DOUBAO_WORK_MODEL, messages: [{ role: 'user', content: [{ type: 'text', text: '运行 pwd' }] }], tools: [{ name: 'bash', description: 'Run command', parameters: {} }] } as any
    const first = []; for await (const chunk of adapter.stream(options)) first.push(chunk)
    const call = first.find(chunk => chunk.type === 'block-end')?.block
    expect(call).toMatchObject({ type: 'tool-call', name: 'bash' })
    expect(first.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'tool-calls' } })
    options.messages.push({ role: 'assistant', content: [call] }, { role: 'tool', toolCallId: call!.id, content: [{ type: 'text', text: '/tmp/test' }] })
    const second = []; for await (const chunk of adapter.stream(options)) second.push(chunk)
    expect(second).toContainEqual({ type: 'text-delta', index: 0, text: '/tmp/test' })
    expect(second.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'stop' } })
  })
})
