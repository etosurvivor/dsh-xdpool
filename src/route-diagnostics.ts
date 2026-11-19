const errorCodes = new Set([
  'context_length_exceeded', 'invalid_request', 'invalid_request_error',
  'model_param_invalid', 'rate_limit_exceeded', 'insufficient_quota',
  'model_not_found', 'invalid_api_key', 'APIG.0101', 'APIG.0203',
])
const parameterNames = new Set([
  'messages', 'role', 'content', 'type', 'text', 'tool_calls', 'tool_call_id',
  'tools', 'tool_choice', 'function', 'name', 'parameters', 'arguments',
  'model', 'stream', 'stream_options', 'max_tokens', 'max_completion_tokens',
  'temperature', 'top_p', 'reasoning', 'reasoning_effort', 'effort',
  'reasoning_content', 'response_format', 'image_url', 'input', 'context',
])
const reasons: ReadonlyArray<readonly [RegExp, string]> = [
  [/first message is not system prompt/iu, 'missing_leading_system'],
  [/context_length_exceeded|maximum context length|input length too long|输入长度超过/iu, 'context_length'],
  [/illegal api invocation from an unapproved channel/iu, 'unapproved_channel'],
  [/tool_calls?.{0,80}tool_call_id|tool result|tool response/iu, 'tool_message_sequence'],
  [/model_param_invalid|request parameters do not meet|请求参数不符合/iu, 'model_parameter_invalid'],
]

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined
}

function knownCode(value: unknown): string | undefined {
  if (typeof value !== 'string' && typeof value !== 'number') return undefined
  const code = String(value)
  if (/^[0-9]{1,6}$/u.test(code) || errorCodes.has(code)) return code
  if (/^InferHub\.APIG\.(?:0101|0203)\.[45][0-9]{2}$/u.test(code)) return code
  return undefined
}

function knownParameter(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 96) return undefined
  const path = value.replace(/\[[0-9]{1,6}\]/gu, '[]').replace(/\.[0-9]{1,6}(?=\.|$)/gu, '[]')
  const parts = path.replace(/\[\]/gu, '').split('.')
  return parts.every(name => parameterNames.has(name)) ? path : undefined
}

/** Never persist raw response text, arbitrary field names, or request data. */
export function routeErrorDetails(message: string): { upstreamCode?: string; upstreamParam?: string; upstreamHint?: string } {
  // Channel adapters sometimes prefix the response with an HTTP status.
  const start = message.indexOf('{')
  const end = message.lastIndexOf('}')
  let body: Record<string, unknown> | undefined
  if (start >= 0 && end > start) {
    try { body = object(JSON.parse(message.slice(start, end + 1))) } catch { /* non-JSON error */ }
  }
  const error = object(body?.error)
  const extended = object(body?.extError) ?? object(error?.extError)
  const upstreamCode = [body?.code, error?.code, extended?.code, body?.error_code, error?.type]
    .map(knownCode).find(value => value !== undefined)
  const upstreamParam = [extended?.param, error?.param, body?.param]
    .map(knownParameter).find(value => value !== undefined)
  const upstreamHint = reasons.find(([pattern]) => pattern.test(message))?.[1]
  return {
    ...(upstreamCode === undefined ? {} : { upstreamCode }),
    ...(upstreamParam === undefined ? {} : { upstreamParam }),
    ...(upstreamHint === undefined ? {} : { upstreamHint }),
  }
}

export function routeTransportKind(error: unknown): string {
  const nodeError = object(error)
  const code = object(nodeError?.cause)?.code ?? nodeError?.code
  switch (code) {
    case 'ETIMEDOUT': case 'UND_ERR_CONNECT_TIMEOUT': case 'UND_ERR_HEADERS_TIMEOUT': case 'UND_ERR_BODY_TIMEOUT': return 'timeout'
    case 'ENOTFOUND': case 'EAI_AGAIN': return 'dns'
    case 'ECONNRESET': case 'EPIPE': case 'UND_ERR_SOCKET': return 'connection_closed'
    case 'ECONNREFUSED': return 'connection_refused'
    case 'ENETUNREACH': case 'EHOSTUNREACH': return 'unreachable'
    case 'CERT_HAS_EXPIRED': case 'SELF_SIGNED_CERT_IN_CHAIN': case 'UNABLE_TO_VERIFY_LEAF_SIGNATURE': return 'tls'
    default:
      if (nodeError?.name === 'AbortError') return 'aborted'
      if (nodeError?.name === 'TimeoutError') return 'timeout'
      return 'transport'
  }
}
