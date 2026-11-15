import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const pack = readFileSync(new URL('../vendor/channel-pack/pack.js', import.meta.url), 'utf8')
const start = pack.indexOf('var CodeArtsAdapter = class extends LlmAdapter {')
const end = pack.indexOf('\nfunction registerCodeArtsLlm(', start)
if (start < 0 || end < 0) throw new Error('CodeArts adapter anchors changed')

class ModelError extends Error {
  constructor(message: string, readonly code: string, readonly detail?: unknown) { super(message) }
}

/** Execute the shipped adapter, replacing only its external host/transport dependencies. */
function fixture(responses: (() => Response)[], model = 'deepseek-v4.1-flash') {
  const requests: Headers[] = []
  const signatures: (Record<string, string> | undefined)[] = []
  const env = {
    LlmAdapter: class {}, LlmError2: ModelError, RemoteCatalogGate: class {},
    SseQuotaExhaustedError: class extends Error {}, SseQueueRetryError: class extends Error {},
    BENEFIT_NOT_FOUND_CODE: 'BENEFIT_NOT_FOUND', BENEFIT_HEADER_REJECTED_CODE: 'BENEFIT_HEADER_REJECTED',
    CODEARTS_BENEFIT_NOT_FOUND_ERROR_CODE: 'InferHub.4004.200', CODEARTS_MAX_OUTPUT_TOKENS: 65536,
    CHAT_API_BASE: 'https://example.invalid/api', PROVIDER: 'codearts',
    serializeMessages: (messages: unknown) => messages,
    isCodeArtsBenefitModel: (id: string) => ['deepseek-v4.1-flash', 'glm-5.3-flash'].includes(id),
    attributionHeaders: () => ({}),
    signRequestHuawei: async (...args: unknown[]) => {
      const extra = args[6] as Record<string, string> | undefined
      signatures.push(extra)
      return new Headers({ ...extra, authorization: `signed-${signatures.length}` })
    },
    isReasoningLoopGuardEnabled: () => false,
    createBlankReasoningSuppressor: () => ({ text: () => '', feed: (text: string) => text }),
    DsmlContentExtractor: class {
      feed(text: string) { return { text, reasoning: '', toolCalls: [] } }
      flush() { return { text: '', reasoning: '', toolCalls: [] } }
    },
    resolveChunkTimeoutMs: () => 1000, resolveFirstTokenTimeoutMs: () => 1000,
    readCodeArtsChunk: (reader: ReadableStreamDefaultReader) => reader.read(),
    isSseQuotaExhaustedErrorCode: () => false, isSseQueueErrorCode: () => false,
    isAuthError: () => false, isQueueError: () => false,
    errorDetail: (text: string) => text, httpErrorCode: () => 'INVALID_REQUEST',
    stripCourseLeakIfEnabled: (text: string) => text,
    resolveEmptyResponseReason: (reason: unknown) => reason,
  }
  const Adapter = new Function(...Object.keys(env), `${pack.slice(start, end)}\nreturn CodeArtsAdapter`)(...Object.values(env))
  const adapter = new Adapter({
    chatId: 'test-chat', sessionId: 'test-session',
    resolveCredential: async () => ({ access_key_id: 'test-ak', secret_access_key: 'test-sk', security_token: 'test-token', expires_at: '2099-01-01' }),
    refresh: async () => {},
    fetchImpl: async (_url: string, init: RequestInit) => {
      requests.push(new Headers(init.headers))
      const response = responses[requests.length - 1]
      if (!response) throw new Error('unexpected extra request: retry is not bounded')
      return response()
    },
  })
  adapter.queryQueueStatus = async () => undefined
  return {
    requests, signatures,
    run: async () => {
      const chunks = []
      for await (const chunk of adapter.stream({ model, messages: [] })) chunks.push(chunk)
      return chunks
    },
  }
}

const success = () => new Response('data: {"choices":[{"delta":{"content":"OK"}}]}\n\ndata: [DONE]\n\n')
const sseError = (code = 'InferHub.APIG.0101.404', message = 'API does not exist') =>
  () => new Response(`data: ${JSON.stringify({ error_code: code, error_msg: message })}\n\n`)

describe('CodeArts does not send the retired benefit header', () => {
  it.each(['deepseek-v4.1-flash', 'glm-5.3-flash', 'openpangu-2.0-pro'])('signs the first request without the benefit header for %s', async model => {
    const f = fixture([success], model)
    expect(await f.run()).toContainEqual(expect.objectContaining({ type: 'text-delta', text: 'OK' }))
    expect(f.requests.map(headers => headers.get('maas_type'))).toEqual([null])
    expect(f.signatures).toEqual([undefined])
  })
  it.each([
    ['prefixed SSE error', sseError()],
    ['APIG message', sseError('Other.Error', 'gateway APIG.0101 rejected')],
    ['HTTP 404', () => new Response('not found', { status: 404 })],
    ['APIG HTTP error', () => new Response('InferHub.APIG.0101.404', { status: 502 })],
    ['benefit not found', sseError('InferHub.4004.200', 'benefit not found')],
  ])('does not repeat a header-free request after %s', async (_name, first) => {
    const f = fixture([first as () => Response])
    await expect(f.run()).rejects.toBeInstanceOf(ModelError)
    expect(f.requests).toHaveLength(1)
    expect(f.requests[0]?.get('maas_type')).toBeNull()
  })
})
