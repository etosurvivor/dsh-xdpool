import { describe, expect, it } from 'vitest'
import { usageChannelLabel } from '../src/client/usage-channel.ts'

describe('usage channel labels', () => {
  it('distinguishes the WorkBuddy regions and the free lane', () => {
    const t = (key: string) => ({ 'ledger.cn': '国内版', 'ledger.global': '国际版', 'ledger.channelFree': '免密通道' })[key] ?? key
    expect(usageChannelLabel({ channel: 'workbuddy', region: 'cn' }, [], t)).toBe('WorkBuddy 国内版')
    expect(usageChannelLabel({ channel: 'workbuddy', region: 'global' }, [], t)).toBe('WorkBuddy 国际版')
    expect(usageChannelLabel({ channel: 'free', region: 'free' }, [], t)).toBe('免密通道')
  })

  it('uses actual channel names, with an honest fallback while the roster loads', () => {
    expect(usageChannelLabel({ channel: 'codearts', region: '' }, [{ id: 'codearts', name: 'CodeArts' }])).toBe('CodeArts')
    expect(usageChannelLabel({ channel: 'unknown-provider', region: '' }, [])).toBe('unknown-provider')
    expect(usageChannelLabel({ region: '' }, [])).toBe('—')
  })
})
