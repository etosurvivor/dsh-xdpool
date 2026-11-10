import { describe, expect, it, vi } from 'vitest'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { recoverCompactionStream } from '../src/compaction-recovery.ts'

const target = { provider: 'xdpool-aggregate', model: 'combo:ds' }
const text = (value: string): StreamChunk => ({ type: 'text-delta', index: 0, text: value })
const finish: StreamChunk = { type: 'finish', reason: { kind: 'stop' } }
const error = (message = 'fetch failed', code = 'UNKNOWN'): StreamChunk => ({ type: 'finish', reason: { kind: 'error', failure: { code, message } } })
const stream = (chunks: StreamChunk[]) => (async function* () { yield* chunks })()
const read = async (chunks: AsyncIterable<StreamChunk>) => {
  const out: StreamChunk[] = []; for await (const chunk of chunks) out.push(chunk); return out
}
const call = (extra: Record<string, unknown> = {}) => ({ provider: 'codearts', model: 'deepseek-v4.1-flash', purpose: 'compaction', messages: [], maxTokens: 8192, ...extra }) as GenerateOptions & { purpose: string }

describe('CodeArts compaction-only transport recovery', () => {
  it('retries a thrown fetch failure through one matching chain and records the actual target', async () => {
    const options = call()
    const retry = vi.fn(() => stream([text('summary'), finish]))
    const recovered = vi.fn()
    const out = await read(recoverCompactionStream(options, () => (async function* () { throw new TypeError('fetch failed') })(), { target: () => target, stream: retry, recovered }))
    expect(out).toEqual([text('summary'), finish])
    expect(retry).toHaveBeenCalledTimes(1)
    expect(retry.mock.calls[0]?.[0]).toMatchObject({ ...target, purpose: 'compaction', messages: [], maxTokens: 8192 })
    expect(options).toMatchObject(target)
    expect(recovered).toHaveBeenCalledTimes(1)
  })

  it('discards a partial failed summary before yielding its replacement', async () => {
    const out = await read(recoverCompactionStream(call(), () => stream([text('partial'), error()]), { target: () => target, stream: () => stream([text('replacement'), finish]) }))
    expect(out).toEqual([text('replacement'), finish])
  })

  it.each([
    'codearts: model request failed with HTTP 504 (APIG.0203 Backend timeout)',
    'codearts: model request failed with HTTP 502',
  ])('recovers a transient gateway failure: %s', async message => {
    const retry = vi.fn(() => stream([text('summary'), finish]))
    expect(await read(recoverCompactionStream(call(), () => stream([error(message)]), { target: () => target, stream: retry }))).toEqual([text('summary'), finish])
    expect(retry).toHaveBeenCalledTimes(1)
  })

  it('leaves a successful original summary untouched', async () => {
    const retry = vi.fn()
    expect(await read(recoverCompactionStream(call(), () => stream([text('original'), finish]), { target: () => target, stream: retry }))).toEqual([text('original'), finish])
    expect(retry).not.toHaveBeenCalled()
  })

  it.each([
    { purpose: 'agent' },
    { purpose: 'title' },
    { provider: 'xdpool-aggregate' },
  ])('does not intercept unrelated requests: %j', async extra => {
    const retry = vi.fn()
    expect(await read(recoverCompactionStream(call(extra), () => stream([error()]), { target: () => target, stream: retry }))).toEqual([error()])
    expect(retry).not.toHaveBeenCalled()
  })

  it('does not retry auth or request validation failures', async () => {
    const failure = error('invalid API key', 'AUTH')
    const retry = vi.fn()
    expect(await read(recoverCompactionStream(call(), () => stream([failure]), { target: () => target, stream: retry }))).toEqual([failure])
    expect(retry).not.toHaveBeenCalled()
  })

  it('respects cancellation and a missing fallback chain', async () => {
    const controller = new AbortController(); controller.abort()
    const retry = vi.fn()
    await read(recoverCompactionStream(call({ signal: controller.signal }), () => stream([error()]), { target: () => target, stream: retry }))
    await read(recoverCompactionStream(call(), () => stream([error()]), { target: () => undefined, stream: retry }))
    expect(retry).not.toHaveBeenCalled()
  })

  it('does not recurse or claim recovery when the fallback also fails', async () => {
    const options = call(); const recovered = vi.fn(); const retry = vi.fn(() => stream([error('fallback failed', 'TRANSPORT')]))
    expect(await read(recoverCompactionStream(options, () => stream([error()]), { target: () => target, stream: retry, recovered }))).toEqual([error('fallback failed', 'TRANSPORT')])
    expect(retry).toHaveBeenCalledTimes(1)
    expect(options.provider).toBe('codearts')
    expect(recovered).not.toHaveBeenCalled()
  })

  it('recovers the host TIMEOUT classification without claiming an unfinished fallback succeeded', async () => {
    const options = call(); const recovered = vi.fn()
    const retry = vi.fn(() => stream([text('unfinished')]))
    expect(await read(recoverCompactionStream(options, () => stream([error('codearts: sse first token timeout after 60000ms', 'TIMEOUT')]), { target: () => target, stream: retry, recovered }))).toEqual([text('unfinished')])
    expect(retry).toHaveBeenCalledTimes(1)
    expect(options.provider).toBe('codearts')
    expect(recovered).not.toHaveBeenCalled()
  })
})
