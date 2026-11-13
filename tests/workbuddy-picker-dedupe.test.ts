import { describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { withoutPoolDuplicates } from '../vendor/channel-pack/pool-model-dedupe.js'

describe('WorkBuddy picker deduplication', () => {
  const channelRows = [{ id: 'shared' }, { id: 'channel-only' }]

  it.each([
    ['buddy', 'xdpool'],
    ['workbuddy', 'xdpool-global'],
  ])('hides overlapping %s models using the corresponding %s pool', async (provider, pool) => {
    const list = vi.fn(async () => [{ id: 'shared' }, { id: 'pool-only' }])
    await expect(withoutPoolDuplicates(channelRows, provider, list)).resolves.toEqual([{ id: 'channel-only' }])
    expect(list).toHaveBeenCalledWith(pool)
  })

  it('retains channel models when the pool is missing, empty, or fails', async () => {
    await expect(withoutPoolDuplicates(channelRows, 'buddy', async () => [])).resolves.toEqual(channelRows)
    await expect(withoutPoolDuplicates(channelRows, 'buddy', async () => { throw new Error('not registered') })).resolves.toEqual(channelRows)
  })

  it('leaves other providers untouched without querying a pool', async () => {
    const list = vi.fn()
    await expect(withoutPoolDuplicates(channelRows, 'codearts', list)).resolves.toEqual(channelRows)
    expect(list).not.toHaveBeenCalled()
  })

  it('registers the real channel adapter with its old route still callable', async () => {
    const pack = readFileSync(new URL('../vendor/channel-pack/pack.js', import.meta.url), 'utf8')
    const match = pack.match(/function registerBuddyLlm\(ctx, options\) \{[\s\S]*?\n\}/u)
    expect(match).not.toBeNull()
    class FakeBuddyAdapter {
      async listModels() { return channelRows }
      async resolveModel(id: string) { return { id } }
    }
    const registerAdapterIdempotent = vi.fn()
    const register = runInNewContext(`(${match![0]})`, {
      CODEBUDDY: { id: 'buddy' }, BuddyAdapter: FakeBuddyAdapter,
      registerAdapterIdempotent, withoutPoolDuplicates,
    }) as (ctx: unknown, options: unknown) => FakeBuddyAdapter
    let poolRows = [{ id: 'shared' }]
    const adapter = register({ llm: { listModels: async () => poolRows } }, {})
    expect(registerAdapterIdempotent).toHaveBeenCalledWith(expect.anything(), ['buddy'], adapter)
    await expect(adapter.listModels()).resolves.toEqual([{ id: 'channel-only' }])
    await expect(adapter.resolveModel('shared')).resolves.toEqual({ id: 'shared' })
    poolRows = []
    await expect(adapter.listModels()).resolves.toEqual(channelRows)
  })
})
