import { describe, expect, it } from 'vitest'
import { createChannelAccountRouting, type ChannelAccountEntry, type ChannelAccountPool } from '../src/channel-account-routing.ts'

function fixture() {
  const accounts: ChannelAccountEntry[] = [{ id: 'a', enabled: true }, { id: 'b', enabled: true }]
  const pool: ChannelAccountPool = {
    listAccountsByProvider: provider => provider === 'trae' ? accounts : [],
    getAvailableAccount: async (provider, model, excluded) => {
      const entry = accounts.find(item => item.enabled && !excluded?.has(item.id) && (item.modelRateLimits?.[model] ?? 0) <= Date.now())
      return provider !== 'trae' || entry === undefined ? null : { entry, credential: {} }
    },
  }
  return { accounts, pool, routing: createChannelAccountRouting(() => pool) }
}

describe('per-request channel account pinning', () => {
  it('isolates concurrent routed accounts and leaves ordinary calls unchanged', async () => {
    const { pool, routing } = fixture()
    expect(routing.candidates('trae', 'm')).toEqual(['a', 'b'])
    const [a, b] = await Promise.all(['a', 'b'].map(id => routing.run('trae', 'm', id, async () => {
      await Promise.resolve()
      return { list: pool.listAccountsByProvider('trae').map(entry => entry.id), picked: (await pool.getAvailableAccount('trae', ''))?.entry.id }
    })))
    expect(a).toEqual({ list: ['a'], picked: 'a' })
    expect(b).toEqual({ list: ['b'], picked: 'b' })
    expect(pool.listAccountsByProvider('trae').map(entry => entry.id)).toEqual(['a', 'b'])
    expect((await pool.getAvailableAccount('trae', ''))?.entry.id).toBe('a')
  })

  it('does not silently rotate after the bound account is excluded or cooled', async () => {
    const { accounts, pool, routing } = fixture()
    await expect(routing.run('trae', 'm', 'a', () => pool.getAvailableAccount('trae', 'm', new Set(['a']))))
      .rejects.toThrow('declined')
    accounts[0]!.modelRateLimits = { m: Date.now() + 60_000 }
    expect(routing.candidates('trae', 'm')).toEqual(['b'])
    await expect(routing.run('trae', 'm', 'a', () => pool.getAvailableAccount('trae', 'm')))
      .rejects.toThrow('unavailable')
  })
})
