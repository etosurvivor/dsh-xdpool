/** A chain's controls are routing intent; each member resolves to its own ladder. */
export const CHAIN_REASONING_EFFORTS = ['low', 'high', 'max'] as const
const LEVELS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const

/** Select a real native effort, keeping Max -> High explicit where Max is absent. */
export function resolveMemberReasoningEffort(
  requested: string,
  supported: readonly string[] | undefined,
): string | undefined {
  if (supported === undefined) return requested
  if (supported.includes(requested)) return requested
  const rank = LEVELS.indexOf(requested as (typeof LEVELS)[number])
  if (rank < 0) return undefined
  if (supported.includes('on')) {
    return requested === 'low' && supported.includes('off') ? 'off' : 'on'
  }
  if (requested === 'max' && supported.includes('high')) return 'high'
  const native = LEVELS.filter(level => supported.includes(level))
  // Prefer a supported lower level, then the model's lowest available level.
  return native.filter(level => LEVELS.indexOf(level) <= rank).at(-1) ?? native[0]
}

/** A fresh request per member prevents one fallback's downgrade leaking to the next. */
export function withMemberReasoningEffort(raw: string, supported: readonly string[] | undefined): string {
  const body = JSON.parse(raw) as Record<string, unknown>
  if (typeof body.reasoning_effort !== 'string') return raw
  const effort = resolveMemberReasoningEffort(body.reasoning_effort, supported)
  if (effort === undefined) delete body.reasoning_effort
  else body.reasoning_effort = effort
  return JSON.stringify(body)
}
