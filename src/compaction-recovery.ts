import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'

type CompactionCall = GenerateOptions & { purpose?: string }
type Target = { provider: string; model: string }

/** Match transport/gateway failures without retrying auth, quota, or bad input. */
function transportFailure(value: unknown): boolean {
  if (value === null || typeof value !== 'object') return false
  const error = value as { code?: unknown; message?: unknown; status?: unknown; statusCode?: unknown; cause?: unknown }
  if ([408, 502, 503, 504].includes(Number(error.status ?? error.statusCode))) return true
  if (typeof error.code === 'string' && /^(?:TRANSPORT|NETWORK|TIMEOUT|ECONNRESET|ECONNREFUSED|EPIPE|ETIMEDOUT|ENOTFOUND|UND_ERR_CONNECT_TIMEOUT|UND_ERR_HEADERS_TIMEOUT|UND_ERR_BODY_TIMEOUT|UND_ERR_SOCKET)$/u.test(error.code)) return true
  if (typeof error.message === 'string' && /fetch failed|network error|socket hang up|\bHTTP (?:408|502|503|504)\b|\bAPIG\.0203\b/iu.test(error.message)) return true
  return error.cause !== value && error.cause !== undefined ? transportFailure(error.cause) : false
}

function failedFinish(chunk: StreamChunk): unknown {
  return chunk.type === 'finish' && chunk.reason.kind === 'error' ? chunk.reason.failure : undefined
}

/**
 * A compaction is an auxiliary call and bypasses the agent's normal request retry.
 * Buffer its first attempt so a transport failure cannot mix partial summaries.
 * Ordinary CodeArts calls keep their own behavior, including the benefit retry.
 */
export function recoverCompactionStream(
  options: CompactionCall,
  next: () => AsyncIterable<StreamChunk>,
  recovery: {
    target: () => Target | undefined
    stream: (options: CompactionCall) => AsyncIterable<StreamChunk>
    recovered?: (from: Target, to: Target) => void
  },
): AsyncIterable<StreamChunk> {
  if (options.purpose !== 'compaction' || options.provider !== 'codearts') return next()
  return (async function* () {
    const initial: StreamChunk[] = []
    let thrown: unknown
    let failure: unknown
    try {
      for await (const chunk of next()) {
        initial.push(chunk)
        if (failedFinish(chunk) !== undefined) failure = failedFinish(chunk)
      }
    } catch (error) {
      thrown = error
      failure = error
    }
    const target = !options.signal?.aborted && transportFailure(failure) ? recovery.target() : undefined
    if (target === undefined || target.provider === options.provider && target.model === options.model) {
      if (thrown !== undefined) throw thrown
      yield* initial
      return
    }
    const from = { provider: options.provider, model: options.model }
    const replacement: StreamChunk[] = []
    let replacementCompleted = false
    for await (const chunk of recovery.stream({ ...options, ...target })) {
      replacement.push(chunk)
      if (chunk.type === 'finish') replacementCompleted = chunk.reason.kind === 'stop'
    }
    if (replacementCompleted) {
      // The basic summarizer reads its auxiliary envelope after the stream ends.
      // Keep the recorded summary provider/model consistent with the actual call.
      if (!Object.isFrozen(options)) Object.assign(options, target)
      recovery.recovered?.(from, target)
    }
    yield* replacement
  })()
}
