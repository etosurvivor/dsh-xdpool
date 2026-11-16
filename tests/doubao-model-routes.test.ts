import { Readable } from 'node:stream'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it, vi } from 'vitest'
import { registerDoubaoRoutes } from '../src/doubao-routes.ts'
import { DoubaoModelStore } from '../src/doubao-model-store.ts'
import { POOL_DOUBAO_MODELS_PATH } from '../src/status-paths.ts'

describe('Doubao models route', () => {
  it('persists selection and rejects unknown models and untrusted origins', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'doubao-routes-'))
    try {
      const store = new DoubaoModelStore(join(dir, 'selection.json'))
      const handlers = new Map<string, (req: any, res: any) => Promise<void>>()
      const changed = vi.fn()
      const ctx = { effect: (f: () => unknown) => f(), webServer: { register: ({ path, handler }: any) => { handlers.set(path, handler); return () => {} } } }
      registerDoubaoRoutes(ctx as never, { session: () => undefined, save: () => {}, clear: () => {}, models: { ready: store.load(), store, catalog: () => [{ id: '0', name: '快速', mode: 'chat' }, { id: 'deepseek', name: 'DeepSeek', mode: 'work' }], changed } })
      const handler = handlers.get(POOL_DOUBAO_MODELS_PATH)!
      async function request(method: string, body?: unknown, origin?: string) {
        const req = Object.assign(Readable.from(body === undefined ? [] : [JSON.stringify(body)]), { method, headers: origin ? { origin } : {} })
        let status = 0, data: any
        const res = { writeHead: (n: number) => { status = n }, end: (raw: string) => { data = JSON.parse(raw) } }
        await handler(req, res); return { status, data }
      }
      const initial = await request('GET'); expect(initial.data.models.map((m: any) => m.enabled)).toEqual([true, true])
      const saved = await request('PUT', { disabled: ['deepseek'] }); expect(saved.status).toBe(200)
      expect(saved.data.models.find((m: any) => m.id === 'deepseek').enabled).toBe(false)
      const reopened = new DoubaoModelStore(join(dir, 'selection.json')); await reopened.load(); expect(reopened.isEnabled('deepseek')).toBe(false)
      expect((await request('PUT', { disabled: ['unknown'] })).status).toBe(400)
      expect((await request('PUT', { disabled: [] }, 'https://untrusted.example')).status).toBe(403)
      expect(changed).toHaveBeenCalledTimes(1)
    } finally { await rm(dir, { recursive: true, force: true }) }
  })
})
