import { AsyncLocalStorage } from 'node:async_hooks'

const timeoutScopeKey = Symbol.for('heybash.xdpool.route-manages-stream-timeout')
const scopes = globalThis as typeof globalThis & Record<symbol, AsyncLocalStorage<boolean> | undefined>
const timeoutScope = scopes[timeoutScopeKey] ??= new AsyncLocalStorage<boolean>()

/** The separately loaded channel pack uses the route's timers for this call only. */
export function withRouteStreamTimeout<T>(action: () => Promise<T>): Promise<T> {
  return timeoutScope.run(true, action)
}

export function isRouteTimeout(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return (error instanceof Error && error.name === 'TimeoutError')
    || /\b(?:timeout|timed?\s*out|ETIMEDOUT)\b|超时/iu.test(message)
}

export type ModelOutputPhase = 'thinking' | 'answer'

export interface RouteDecodeSample {
  decodeMs: number
  decodeTokens: number
}

export interface RouteReading {
  channel: string
  model: string
  decode?: RouteDecodeSample
}

/** Time model output as it arrives upstream, before the route buffers it. */
export class RouteDecodeTiming {
  private firstAt: number | undefined
  private lastAt: number | undefined

  markOutput(at: number = performance.now()): void {
    this.firstAt ??= at
    this.lastAt = at
  }

  sample(outputTokens: number | undefined): RouteDecodeSample | undefined {
    if (outputTokens === undefined || outputTokens <= 0 || this.firstAt === undefined || this.lastAt === undefined) return
    const decodeMs = this.lastAt - this.firstAt
    // A single payload or frames replayed in one burst cannot establish a rate.
    if (decodeMs >= 120) return { decodeMs, decodeTokens: outputTokens }
  }
}

function hasText(delta: Record<string, unknown>, keys: readonly string[]): boolean {
  return keys.some(key => {
    const value = delta[key]
    return typeof value === 'string' && value.length > 0
  })
}

export function modelOutputPhase(delta: Record<string, unknown>): ModelOutputPhase | undefined {
  if (hasText(delta, ['content', 'text', 'partial_json', 'arguments'])
    || (Array.isArray(delta.tool_calls) && delta.tool_calls.length > 0)) return 'answer'
  if (hasText(delta, ['reasoning_content', 'reasoning', 'thinking'])) return 'thinking'
  return undefined
}

function object(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined
}

/** Website keepalives, role headers and usage never extend the output deadline. */
export function observeRoutePayload(payload: string, onOutput: (phase: ModelOutputPhase) => void): void {
  let frame: Record<string, unknown> | undefined
  try { frame = object(JSON.parse(payload)) } catch { return }
  if (frame === undefined) return
  const type = frame.type
  const choices: unknown[] = Array.isArray(frame.choices) ? frame.choices : []
  if (frame.error != null || type === 'error' || type === 'response.failed' || type === 'response.cancelled'
    || choices.some(choice => /^(?:abort(?:ed)?|cancel(?:led)?|error)$/iu.test(String(object(choice)?.finish_reason ?? '')))) {
    throw new Error('upstream ended the response with an error or abort')
  }
  let phase = modelOutputPhase(object(frame.data) ?? {})
  for (const choice of choices) {
    const entry = object(choice)
    const output = modelOutputPhase(object(entry?.delta ?? entry?.message) ?? {})
    if (output === 'answer' || phase === undefined) phase = output
  }
  const block = object(frame.content_block ?? frame.item)
  if (type === 'content_block_delta') phase = modelOutputPhase(object(frame.delta) ?? {})
  if (type === 'content_block_start') phase = block?.type === 'tool_use' ? 'answer' : modelOutputPhase(block ?? {})
  if (type === 'response.output_item.added' && block?.type === 'function_call') phase = 'answer'
  if (typeof type === 'string' && typeof frame.delta === 'string' && frame.delta.length > 0) {
    if (/^response\.reasoning(?:_text|_summary_text)?\.delta$/u.test(type)) phase = 'thinking'
    if (/^response\.(?:output_text|function_call_arguments)\.delta$/u.test(type)) phase = 'answer'
  }
  if (phase !== undefined) onOutput(phase)
}

/** Some adapters don't settle next() when aborted. Move on without waiting for them. */
export async function* untilRouteAbort<T>(events: AsyncIterable<T>, signal: AbortSignal): AsyncGenerator<T> {
  const iterator = events[Symbol.asyncIterator]()
  let exhausted = false
  try {
    for (;;) {
      signal.throwIfAborted()
      let abort!: () => void
      const interrupted = new Promise<never>((_resolve, reject) => {
        abort = () => reject(signal.reason)
        signal.addEventListener('abort', abort, { once: true })
      })
      let next: IteratorResult<T>
      try {
        next = await Promise.race([iterator.next(), interrupted])
      } finally {
        signal.removeEventListener('abort', abort)
      }
      if (next.done) {
        exhausted = true
        return
      }
      yield next.value
    }
  } finally {
    if (!exhausted) void iterator.return?.().catch(() => {})
  }
}
