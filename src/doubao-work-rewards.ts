/** Parsing and one-shot claiming for the Doubao Work daily reward. */
export interface DailyReward {
  group: string
  item: string
  checked: boolean
  canClaim: boolean
  amount?: number
}

type JsonObject = Record<string, unknown>
const object = (value: unknown): JsonObject | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : undefined
const str = (value: unknown): string | undefined => typeof value === 'string' && value.length > 0 ? value : undefined

/** Ignore non-daily activities and fail closed on ambiguous daily activities. */
export function dailyRewardOf(value: unknown, fallbackGroup: string): DailyReward | undefined {
  const found = new Map<string, DailyReward>()
  function visit(value: unknown, inheritedGroup: string, depth: number): void {
    const node = object(value)
    if (!node || depth > 8) return
    const group = str(node.campaign_group_code) ?? str(node.campaign_code) ?? inheritedGroup
    for (const key of ['tasks', 'campaigns', 'milestones']) {
      const rows = node[key]
      if (!Array.isArray(rows)) continue
      for (const value of rows) {
        const row = object(value), daily = object(row?.daily_checkin)
        const item = str(row?.campaign_code)
        const rowGroup = str(row?.campaign_group_code) ?? group
        if (!row || !daily || !item || !rowGroup || typeof daily.checked_in_today !== 'boolean') continue
        const amountRaw = object(daily.reward)?.reward_amount
        const amount = typeof amountRaw === 'number' && Number.isFinite(amountRaw) ? amountRaw : undefined
        const direct = Number(row.reward_mode) === 2 || key === 'milestones'
        const state = Number(row.task_status)
        found.set(`${rowGroup}\0${item}`, {
          group: rowGroup, item, checked: daily.checked_in_today,
          canClaim: direct && (state === 1 || state === 2 || state === 4),
          ...(amount === undefined ? {} : { amount }),
        })
      }
    }
    visit(node.campaign_group, group, depth + 1)
    if (Array.isArray(node.campaign_groups)) for (const child of node.campaign_groups) visit(child, group, depth + 1)
  }
  visit(object(value)?.data ?? value, fallbackGroup, 0)
  if (found.size > 1) throw new Error('豆包工作存在多个每日签到活动，无法安全确定领取对象')
  return found.values().next().value
}

export type RewardPost = (path: string, body: JsonObject) => Promise<unknown>
export interface RewardLedger {
  /** Persist before submitting; failure must prevent the write request. */
  pending(): Promise<boolean>
  markPending(): Promise<void>
  clearPending(): Promise<void>
}
export type RewardOutcome = 'claimed' | 'already-claimed' | 'pending' | 'inactive' | 'not-ready'

/** Caller serializes invocations, and scopes the durable ledger to account and day. */
export async function checkInDoubaoWork(post: RewardPost, ledger: RewardLedger): Promise<RewardOutcome> {
  const launch = object(await post('/alice/user/launch', {}))
  const group = str(object(object(launch?.data ?? launch)?.ug_campaign_info)?.campaign_group_code)
  if (!group) return 'inactive'
  const path = group === 'pc_incentive_task_mvp_v3' ? '/alice/ug/campaign/v3/detail/' : '/alice/ug/campaign/list/'
  const get = async () => dailyRewardOf(await post(path, { campaign_group_code: group }), group)
  const before = await get()
  if (!before) return 'inactive'
  if (before.checked) { await ledger.clearPending(); return 'already-claimed' }
  if (await ledger.pending()) return 'pending'
  if (!before.canClaim) return 'not-ready'
  await ledger.markPending()
  try {
    await post('/alice/ug/campaign/item/reward/claim/', {
      task_id: '', campaign_group_code: before.group, campaign_item_code: before.item,
    })
  } catch {
    // A transport error does not prove the server did not apply the claim.
  }
  const after = await get().catch(() => undefined)
  if (after?.group === before.group && after.item === before.item && after.checked) {
    await ledger.clearPending()
    return 'claimed'
  }
  return 'pending'
}
