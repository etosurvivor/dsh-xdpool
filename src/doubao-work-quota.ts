/** Account quota is separated into rolling subscription windows and rewards. */
export interface DoubaoQuotaWindow {
  label: string
  remaining?: number
  total?: number
  remainingPercent?: number
  unlimited: boolean
}
export interface DoubaoQuota { windows: DoubaoQuotaWindow[]; reward?: DoubaoQuotaWindow }
type JsonObject = Record<string, unknown>
function object(value: unknown): JsonObject | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : undefined
}
function nonnegative(value: unknown): number | undefined {
  if (typeof value !== 'number' && (typeof value !== 'string' || value.trim() === '')) return undefined
  const result = Number(value)
  return Number.isFinite(result) && result >= 0 ? result : undefined
}
function limits(section: unknown): { group: JsonObject; limit: JsonObject }[] {
  const groups = object(section)?.window_limit_groups
  if (!Array.isArray(groups)) return []
  return groups.flatMap(value => {
    const group = object(value), rows = group?.window_limits
    if (!group || !Array.isArray(rows)) return []
    return rows.flatMap(row => { const limit = object(row); return limit ? [{ group, limit }] : [] })
  })
}
function convert(label: string, limit: JsonObject): DoubaoQuotaWindow {
  const total = nonnegative(limit.total_amount), used = nonnegative(limit.used_amount)
  const percentage = nonnegative(limit.used_percent)
  return {
    label,
    ...(total === undefined ? {} : { total }),
    ...(total === undefined || used === undefined ? {} : { remaining: Math.max(0, total - used) }),
    ...(percentage === undefined ? {} : { remainingPercent: Math.max(0, Math.min(100, 100 - percentage)) }),
    unlimited: limit.unlimited === true || object(limit.exemption)?.active === true,
  }
}
export function parseDoubaoQuota(value: unknown): DoubaoQuota {
  const data = object(object(value)?.data ?? value)
  if (!data) throw new Error('豆包工作额度响应格式无效')
  const member = object(data.member_info)
  const personal = limits(data.window_limit_section), enterprise = limits(data.enterprise_window_limit_section)
  const enterpriseUsable = enterprise.some(({ limit }) => [1, 2, 4].includes(Number(limit.window_type)))
    && object(data.enterprise_window_limit_section)?.usage_exhausted !== true
  const personalUsable = personal.some(({ limit }) => [1, 2, 4].includes(Number(limit.window_type)))
    && object(data.window_limit_section)?.usage_exhausted !== true
  const enterpriseSelected = member?.hasEnterpriseSubscription === true
    && (enterpriseUsable || member?.hasActiveSubscription !== true || !personalUsable)
  const windows: DoubaoQuotaWindow[] = []
  const main = enterpriseSelected ? enterprise : member?.hasActiveSubscription === true ? personal : []
  for (const { group, limit } of main) {
    const label = ({ 1: '5小时', 2: '近7天', 4: '每月' } as Record<number, string>)[Number(limit.window_type)]
    if (!label) continue
    const groupName = typeof group.feature_group_name === 'string' ? group.feature_group_name.trim() : ''
    windows.push(convert(groupName ? `${groupName} ${label}` : label, limit))
  }
  if (!enterpriseSelected) for (const { limit } of limits(data.quota_package_section)) {
    if (Number(limit.window_type) === 3) windows.push(convert('订阅', limit))
  }
  const reward = enterpriseSelected ? undefined : limits(data.incentive_quota_section).find(({ limit }) => Number(limit.window_type) === 3)
  return { windows, ...(reward === undefined ? {} : { reward: convert('奖励', reward.limit) }) }
}
