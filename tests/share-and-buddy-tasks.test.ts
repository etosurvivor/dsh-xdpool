import { describe, expect, it } from 'vitest'
import { WorkBuddyUpstreamClient, type WorkBuddyTask } from '../src/upstream.ts'
import { WorkBuddyScheduler } from '../src/scheduler.ts'
import type { WorkBuddyAccount, WorkBuddyAccountPool, WorkBuddyCredential } from '../src/accounts.ts'
import { skillShareLinkChain } from '../src/task-events.ts'

const credential = { accessToken: 'token', refreshToken: 'refresh', expiresAtMs: Date.now() + 3600000, uid: 'uid', domain: '' } as WorkBuddyCredential
const task = (code: string, overrides: Partial<WorkBuddyTask> = {}): WorkBuddyTask => ({
  taskCode: code, title: code, credit: 10, energy: 1, hasReward: true, current: 0, target: 1,
  acceptStatus: 'accepted', status: '', claimable: false, claimed: false, locked: false, jumpUrl: '', ...overrides,
})
const ok = (data: unknown) => new Response(JSON.stringify({ code: 0, data }), { status: 200 })

describe('real share-link protocol', () => {
  it('lists public skills and creates a link without a recipient', async () => {
    const calls: {url:string; body:any}[] = []
    const client = new WorkBuddyUpstreamClient({ fetchImpl: async (input, init) => {
      const url = String(input); const body = JSON.parse(String(init?.body)); calls.push({ url, body })
      if (url.endsWith('/market/skill/list')) return ok({ skills: [{ skill_id: 'skill-1', display_name_zh: '公开技能', description_zh: '公开介绍' }] })
      if (url.endsWith('/asset-shares/c2c/channels')) return ok({ share_code: 'share-1', ways: [{ share_way: 'link', resource_ref: 'https://example.test/link' }] })
      throw new Error('unexpected endpoint')
    } })
    const skills = await client.shareableSkills(credential)
    const result = await client.createSkillShareLink(credential, skills[0]!)
    expect(result).toEqual({ shareCode: 'share-1' })
    expect(calls.map(c => c.url)).toEqual(['https://www.codebuddy.cn/v2/operation-platform/market/skill/list', 'https://open.workbuddy.cn/api/v2/open-platform/asset-shares/c2c/channels'])
    expect(calls[1]!.body).toMatchObject({ asset_kind: 'skill', asset_source: 'market', ways: ['link'] })
    expect(calls[1]!.body).not.toHaveProperty('recipient')
    expect(JSON.parse(calls[1]!.body.asset_ref)).toEqual({ asset_id: 'skill-1' })
  })
  it('refuses an incomplete share receipt and never creates an event from it', async () => {
    const client = new WorkBuddyUpstreamClient({ fetchImpl: async () => ok({ share_code: 'x', ways: [] }) })
    await expect(client.createSkillShareLink(credential, { id: 'x', name: 'public', description: '' })).rejects.toThrow(/no share code or link/)
    expect(() => skillShareLinkChain({ id: 'x', name: 'public' }, '')).toThrow()
  })
  it('uses two link events carrying the real share code', () => {
    const chain = skillShareLinkChain({ id: 'skill-1', name: '技能' }, 'share-1', 123)
    expect(chain.identity).toBe('skill-share')
    expect(chain.events).toMatchObject([{ eventCode: 'skill_share_channel_action', id: 'share-1', panelAction: 'click' }, { id: 'share-1', panelAction: 'success' }])
  })
})

describe('skill and first Buddy automation', () => {
  function setup(input: { tasks: WorkBuddyTask[]; hasBuddy?: boolean; failShare?: boolean; adoptionReward?: boolean; noScore?: boolean; failBuddyRead?: boolean }) {
    const calls: string[] = []
    let rows = input.tasks.map(x => ({ ...x }))
    let buddy = input.hasBuddy ?? false
    const account = { id: 'account', credential, cooldownUntilMs: 0, label: 'test' } as WorkBuddyAccount
    const pool = { list: () => [account], isDisabled: () => false, reviveBenched: async () => [] } as unknown as WorkBuddyAccountPool
    const client = {
      listTasks: async () => rows,
      acceptTasks: async (_: unknown, codes: string[]) => { calls.push('accept:' + codes.join(',')); rows = rows.map(t => codes.includes(t.taskCode) ? { ...t, acceptStatus: 'accepted' } : t) },
      shareableSkills: async () => { calls.push('market'); return [{ id: 'skill-1', name: 'public', description: '' }] },
      createSkillShareLink: async () => { calls.push('create-link'); if (input.failShare) throw new Error('failed'); return { shareCode: 'share-1' } },
      buddyInfo: async () => { calls.push('buddy-info'); if (input.failBuddyRead) throw new Error('buddy read failed'); return buddy ? { instanceId: 1, name: 'buddy' } : undefined },
      buddyAgree: async () => { calls.push('agree') },
      buddyAdoptFirst: async () => { calls.push('adopt'); buddy = true; rows = rows.map(t => t.taskCode === 'first_buddy' ? { ...t, current: 1, claimable: !input.adoptionReward, claimed: !!input.adoptionReward, acceptStatus: input.adoptionReward ? 'claimed' : t.acceptStatus } : t); return input.adoptionReward ? { credit: 300, energy: 8 } : { credit: 0, energy: 0 } },
      reportDesktopEvents: async (_: unknown, events: Record<string, unknown>[]) => { calls.push('event:' + String(events[0]?.eventCode)); if (events[0]?.eventCode === 'skill_share_channel_action' && !input.noScore) rows = rows.map(t => t.taskCode === 'skill_share' ? { ...t, current: 1, claimable: true } : t) },
      claimTaskReward: async (_: unknown, code: string) => { calls.push('claim:' + code); rows = rows.map(t => t.taskCode === code ? { ...t, claimed: true, claimable: false, acceptStatus: 'claimed' } : t); return { credit: 10, energy: 1 } },
    } as unknown as WorkBuddyUpstreamClient
    const scheduler = new WorkBuddyScheduler(pool, client, { enabled: true, accountDelayMs: 0, eventScoreWaitMs: 0, expertGapMs: 0 })
    return { calls, scheduler, client, account, rows: () => rows }
  }
  it('does the real sequence and claims only after the returned progress is complete', async () => {
    const x = setup({ tasks: [task('first_buddy'), task('skill_share')] })
    const result = await x.scheduler.runNow('tasks', true)
    expect(x.calls).toContain('agree'); expect(x.calls).toContain('adopt')
    expect(x.calls.indexOf('create-link')).toBeLessThan(x.calls.indexOf('event:skill_share_channel_action'))
    expect(x.calls).toContain('claim:first_buddy'); expect(x.calls).toContain('claim:skill_share')
    expect(result.claimed).toBe(2)
  })
  it('records a real direct adoption receipt without claiming it twice', async () => {
    const x = setup({ tasks: [task('first_buddy')], adoptionReward: true })
    const result = await x.scheduler.runNow('tasks', true)
    expect(x.calls).toContain('adopt')
    expect(x.calls).not.toContain('claim:first_buddy')
    expect(result.credit).toBe(300)
    expect(result.energy).toBe(8)
    expect(result.items).toContainEqual({ title: 'Buddy 领养奖励', status: 'claimed', credit: 300, energy: 8 })
  })
  it('does not send an event or claim when link creation fails', async () => {
    const x = setup({ tasks: [task('skill_share')], failShare: true })
    const result = await x.scheduler.runNow('tasks', true)
    expect(result.items).toContainEqual({ title: 'skill_share', status: 'failed', note: 'automatic completion failed' })
    expect(x.calls).toContain('create-link')
    expect(x.calls).not.toContain('event:skill_share_channel_action')
    expect(x.calls).not.toContain('claim:skill_share')
  })
  it('does not claim a link whose scoring has not arrived', async () => {
    const x = setup({ tasks: [task('skill_share')], noScore: true })
    const result = await x.scheduler.runNow('tasks', true)
    expect(x.calls).toContain('event:skill_share_channel_action')
    expect(x.calls).not.toContain('claim:skill_share')
    expect(result.items).toContainEqual({ title: 'skill_share', status: 'skipped', note: 'not scored yet' })
  })
  it('never adopts when Buddy status cannot be read', async () => {
    const x = setup({ tasks: [task('first_buddy')], failBuddyRead: true })
    const result = await x.scheduler.runNow('tasks', true)
    expect(x.calls).not.toContain('agree')
    expect(x.calls).not.toContain('adopt')
    expect(x.calls).not.toContain('claim:first_buddy')
    expect(result.items).toContainEqual({ title: 'first_buddy', status: 'failed', note: 'automatic completion failed' })
  })
  it('accepts the share task before creating its link', async () => {
    const x = setup({ tasks: [task('skill_share', { acceptStatus: 'not_accepted' })] })
    await x.scheduler.runNow('tasks', true)
    expect(x.calls.indexOf('accept:skill_share')).toBeGreaterThanOrEqual(0)
    expect(x.calls.indexOf('accept:skill_share')).toBeLessThan(x.calls.indexOf('create-link'))
  })
  it('does not create shares or adopt again when tasks are already claimed', async () => {
    const x = setup({ tasks: [task('first_buddy', { claimed: true }), task('skill_share', { claimed: true })], hasBuddy: true })
    await x.scheduler.runNow('tasks', true)
    expect(x.calls).not.toContain('adopt'); expect(x.calls).not.toContain('create-link')
  })
})
