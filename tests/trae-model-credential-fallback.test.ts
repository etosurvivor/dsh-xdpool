import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
const pack = readFileSync(new URL('../vendor/channel-pack/pack.js', import.meta.url), 'utf8')
const start = pack.indexOf('  async fetchModelsUncached(pool) {', pack.indexOf('var TraeAuth = class'))
const end = pack.indexOf('  /** 记录一条警告', start)
if (start < 0 || end < 0) throw new Error('TRAE model method missing')
const method = pack.slice(start, end)
const create = new Function('credentialRef6', 'parseCredential5', 'TRAE_BATCH_MODELS_PATH', 'traeSOLOHeaders', 'TRAE_REQUEST_TIMEOUT_MS', 'parseTraeBatchModelList', `return class { ${method} }`)

describe('TRAE model discovery with pooled credentials', () => {
  it('uses an enabled cooling account credential ref and skips disabled accounts', async () => {
    const resolve = vi.fn(async (ref: string) => ref === 'enabled-ref' ? { value: '{"access_token":"enabled-token"}' } : undefined)
    const fetcher = vi.fn(async (_url: string, init: RequestInit) => {
      expect((init.headers as Record<string, string>).Authorization).toBe('Bearer enabled-token')
      return new Response(JSON.stringify({ models: ['real-model'] }), { status: 200 })
    })
    const Adapter = create((x: string) => x, JSON.parse, '/models', (c: { access_token: string }) => ({ Authorization: `Bearer ${c.access_token}` }), 1000, (v: { models: string[] }) => v.models)
    const auth = Object.assign(new Adapter(), { product: { id: 'trae', agentHost: 'https://example.invalid' }, ctx: { credentials: { resolve } }, fetchImpl: fetcher, warn: () => {}, credentialRefName: 'TRAE_ACCESS_TOKEN' })
    const pool = { getAvailableAccount: async () => undefined, listAccountsByProvider: () => [{ enabled: false, credentialRef: 'disabled-ref' }, { enabled: true, credentialRef: 'enabled-ref' }] }
    expect(await auth.fetchModelsUncached(pool)).toEqual(['real-model'])
    expect(resolve).not.toHaveBeenCalledWith('disabled-ref')
    expect(resolve).toHaveBeenCalledWith('enabled-ref')
  })
})
