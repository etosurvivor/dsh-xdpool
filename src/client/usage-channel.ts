import type { PoolWebChannel } from '../status-paths.ts'
import type { XdPoolSettingsKey } from './locales.ts'

type Translate = (key: XdPoolSettingsKey, params?: Record<string, unknown>) => string

/** Label the channel that actually served a usage row, without guessing vendors. */
export function usageChannelLabel(
  row: { channel?: string; region: string },
  channels: readonly Pick<PoolWebChannel, 'id' | 'name'>[],
  t?: Translate,
): string {
  const channel = row.channel ?? ''
  if (channel === 'workbuddy' || (channel === '' && (row.region === 'cn' || row.region === 'global'))) {
    const region = row.region === 'global' ? (t?.('ledger.global') ?? 'Global')
      : row.region === 'cn' ? (t?.('ledger.cn') ?? 'CN') : row.region
    return region ? `WorkBuddy ${region}` : 'WorkBuddy'
  }
  if (channel === 'free') return t?.('ledger.channelFree') ?? 'Free lane'
  return channels.find(item => item.id === channel)?.name || channel || '—'
}
