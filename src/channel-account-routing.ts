import { AsyncLocalStorage } from 'node:async_hooks'

/** The account-pool seam provided by the bundled channel pack. */
export interface ChannelAccountEntry {
  id: string
  enabled: boolean
  modelRateLimits?: Record<string, number>
}
export interface ChannelAccountPool {
  listAccountsByProvider(provider: string): readonly ChannelAccountEntry[]
  getAvailableAccount(provider: string, model: string, excluded?: ReadonlySet<string>): Promise<{ entry: ChannelAccountEntry; credential: unknown } | null>
}

interface Pin { provider: string; model: string; accountId: string }
const scope = new AsyncLocalStorage<Pin>()
const patched = new WeakSet<object>()

/**
 * Restrict only the current asynchronous routed request to its selected account.
 * Ordinary direct calls and other simultaneous requests keep the pack's own
 * account selection and all of its reserve / disabled / credential checks.
 */
function install(pool: ChannelAccountPool): void {
  if (patched.has(pool)) return
  const list = pool.listAccountsByProvider.bind(pool)
  const acquire = pool.getAvailableAccount.bind(pool)
  pool.listAccountsByProvider = (provider) => {
    const entries = list(provider)
    const pin = scope.getStore()
    if (pin === undefined || pin.provider !== provider) return entries
    const entry = entries.find(item => item.id === pin.accountId && eligible(item, pin.model))
    if (entry === undefined) throw new Error('routed channel account is unavailable')
    return [entry]
  }
  pool.getAvailableAccount = async (provider, model, excluded) => {
    const pin = scope.getStore()
    if (pin === undefined || pin.provider !== provider) return acquire(provider, model, excluded)
    if (excluded?.has(pin.accountId)) throw new Error('routed channel account declined the request')
    const entries = list(provider)
    if (!entries.some(item => item.id === pin.accountId && eligible(item, pin.model))) {
      throw new Error('routed channel account is unavailable')
    }
    const omit = new Set(excluded ?? [])
    for (const entry of entries) if (entry.id !== pin.accountId) omit.add(entry.id)
    const selected = await acquire(provider, pin.model, omit)
    if (selected?.entry.id !== pin.accountId) throw new Error('routed channel account is unavailable')
    return selected
  }
  patched.add(pool)
}

function eligible(entry: ChannelAccountEntry, model: string): boolean {
  return entry.enabled && (entry.modelRateLimits?.[model] ?? 0) <= Date.now()
}

export interface ChannelAccountRouting {
  /** Undefined means the pack service is unavailable; [] means no eligible account. */
  candidates(provider: string, model: string): readonly string[] | undefined
  run<T>(provider: string, model: string, accountId: string, action: () => Promise<T>): Promise<T>
}

export function createChannelAccountRouting(getPool: () => ChannelAccountPool | undefined): ChannelAccountRouting {
  return {
    candidates(provider, model) {
      const pool = getPool()
      if (pool == null || typeof pool.listAccountsByProvider !== 'function' || typeof pool.getAvailableAccount !== 'function') return undefined
      install(pool)
      const entries = pool.listAccountsByProvider(provider)
      if (entries.length === 0) return undefined // legacy single-credential or a non-pack adapter
      return entries.filter(entry => eligible(entry, model)).map(entry => entry.id)
    },
    async run(provider, model, accountId, action) {
      const pool = getPool()
      if (pool == null || typeof pool.listAccountsByProvider !== 'function' || typeof pool.getAvailableAccount !== 'function') throw new Error('routed channel account service is unavailable')
      install(pool)
      return scope.run({ provider, model, accountId }, action)
    },
  }
}
