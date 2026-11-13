import { describe, expect, it } from 'vitest'
import { checkInDoubaoWork, dailyRewardOf, type RewardPost } from '../src/doubao-work-rewards.ts'

const group = 'pc_incentive_task_mvp_v3'
const detail = (checked: boolean) => ({ data: { campaign_groups: [{ campaign_group_code: group, tasks: [{ campaign_code: 'daily_signin', task_status: 1, reward_mode: 2, daily_checkin: { checked_in_today: checked, reward: { reward_amount: 200 } } }] }] } })

describe('Doubao daily reward', () => {
  it('uses upstream checked status rather than task state', () => {
    expect(dailyRewardOf(detail(false), group)).toMatchObject({ checked: false, canClaim: true, amount: 200 })
    expect(dailyRewardOf(detail(true), group)).toMatchObject({ checked: true })
  })
  it('persists a pending marker before a claim and confirms before success', async () => {
    let pending = false, markedBeforeClaim = false, checked = false, writes = 0
    const ledger = { pending: async () => pending, markPending: async () => { pending = true }, clearPending: async () => { pending = false } }
    const post: RewardPost = async path => {
      if (path.endsWith('/launch')) return { data: { ug_campaign_info: { campaign_group_code: group } } }
      if (path.includes('/detail/')) return detail(checked)
      writes++; markedBeforeClaim = pending; checked = true; return { data: {} }
    }
    expect(await checkInDoubaoWork(post, ledger)).toBe('claimed')
    expect(markedBeforeClaim).toBe(true)
    expect(pending).toBe(false)
    expect(await checkInDoubaoWork(post, ledger)).toBe('already-claimed')
    expect(writes).toBe(1)
  })
  it('does not resend an uncertain claim on subsequent attempts', async () => {
    let pending = false, writes = 0
    const ledger = { pending: async () => pending, markPending: async () => { pending = true }, clearPending: async () => { pending = false } }
    const post: RewardPost = async path => {
      if (path.endsWith('/launch')) return { data: { ug_campaign_info: { campaign_group_code: group } } }
      if (path.includes('/detail/')) return detail(false)
      writes++; throw new Error('timeout')
    }
    expect(await checkInDoubaoWork(post, ledger)).toBe('pending')
    expect(await checkInDoubaoWork(post, ledger)).toBe('pending')
    expect(writes).toBe(1)
  })
})
