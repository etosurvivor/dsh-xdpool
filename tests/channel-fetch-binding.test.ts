import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { createContext, runInContext } from 'node:vm'

/** Exercise the vendored runtime function itself without making network calls. */
function runtime(initial: (...args: unknown[]) => unknown) {
  const pack = readFileSync(new URL('../vendor/channel-pack/pack.js', import.meta.url), 'utf8')
  const begin = pack.indexOf('function createChannelFetch(options = {}) {')
  const end = pack.indexOf('// vendor/channel-pack/src/gemini-oauth.ts', begin)
  if (begin < 0 || end < 0) throw new Error('channel network function not found')
  const context = createContext({ fetch: initial, URL, Request, process, loopback: () => true })
  const create = runInContext(`${pack.slice(begin, end)}\ncreateChannelFetch`, context) as (options?: object) => { fetch: (url: string) => Promise<unknown> }
  return { create, context }
}

describe('vendored channel network transport', () => {
  it('keeps the fetch active at creation after global fetch is replaced', async () => {
    const { create, context } = runtime(async () => 'original')
    const service = create()
    context.fetch = async () => 'replaced'
    expect(await service.fetch('https://example.test')).toBe('original')
  })
  it('honours an explicitly injected transport', async () => {
    const { create } = runtime(async () => 'original')
    const service = create({ fetchImpl: async () => 'injected' })
    expect(await service.fetch('https://example.test')).toBe('injected')
  })
})
