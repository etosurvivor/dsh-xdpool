import { describe, expect, it } from 'vitest'
import { WorkBuddyUpstreamClient, type WorkBuddyCredential } from '../src/upstream.ts'
import { automationGroup, automationNote } from '../src/client/automation-note.ts'
import { en, zh } from '../src/client/locales.ts'

const credential = { accessToken: 'test', refreshToken: 'test', uid: '1', domain: '' } as WorkBuddyCredential

describe('growth task status', () => {
  it('preserves real task codes and distinguishes claimed, complete and incomplete progress', async () => {
    const tasks = [
      { task_code: 'first_buddy', accept_status: 'claimed', progress: { current: 1, target: 1 } },
      { task_code: 'skill_share', accept_status: 'accepted', progress: { current: 1, target: 1 } },
      { task_code: 'wb_wechat_oa_subscribe_task', accept_status: 'accepted', progress: { current: 0, target: 1 } },
    ]
    const client = new WorkBuddyUpstreamClient({ fetchImpl: async () => new Response(JSON.stringify({ code: 0, data: { tasks } }), { status: 200 }) })
    const parsed = await client.listTasks(credential)
    expect(parsed.map(x => ({ code: x.taskCode, claimed: x.claimed, claimable: x.claimable }))).toEqual([
      { code: 'first_buddy', claimed: true, claimable: false },
      { code: 'skill_share', claimed: false, claimable: true },
      { code: 'wb_wechat_oa_subscribe_task', claimed: false, claimable: false },
    ])
  })
  it('translates uncovered and unscored reasons separately while preserving errors', () => {
    const translateZh = (key: keyof typeof zh) => zh[key]
    const translateEn = (key: keyof typeof en) => en[key]
    expect(automationNote('not covered by automation', translateZh)).toContain('暂不支持自动完成')
    expect(automationNote('not scored yet', translateZh)).toContain('等待计分')
    expect(automationNote('not covered by automation', translateEn)).toContain('manually')
    expect(automationNote('upstream error', translateZh)).toBe('upstream error')
    expect(automationGroup({ title: '分享技能', status: 'skipped', note: 'not covered by automation' })).toBe('uncovered')
    expect(automationGroup({ title: '等待计分', status: 'skipped', note: 'not scored yet' })).toBe('skipped')
    expect(automationGroup({ title: '已领取', status: 'already' })).toBe('already')
  })
})
