import { describe, expect, it } from 'vitest'
import { parseDoubaoQuota } from '../src/doubao-work-quota.ts'

describe('Doubao quota', () => {
  it('keeps the 7-day window and reward balance separate', () => {
    const result = parseDoubaoQuota({ data: {
      member_info: { hasActiveSubscription: true, hasEnterpriseSubscription: false },
      window_limit_section: { window_limit_groups: [{ window_limits: [{ window_type: 2, total_amount: '500', used_amount: '50', used_percent: 10 }] }] },
      incentive_quota_section: { window_limit_groups: [{ window_limits: [{ window_type: 3, total_amount: '200', used_amount: '25' }] }] },
    } })
    expect(result.windows).toMatchObject([{ label: '近7天', remaining: 450, total: 500 }])
    expect(result.reward).toMatchObject({ label: '奖励', remaining: 175, total: 200 })
  })
  it('does not invent a zero reward or add overlapping windows', () => {
    const result = parseDoubaoQuota({ data: { member_info: { hasActiveSubscription: true }, window_limit_section: { window_limit_groups: [{ window_limits: [
      { window_type: 1, total_amount: '100', used_amount: '20' }, { window_type: 2, total_amount: '500', used_amount: '0' },
    ] }] } } })
    expect(result.windows.map(item => item.remaining)).toEqual([80, 500])
    expect(result.reward).toBeUndefined()
  })
})
