import { describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { syncMirror } from '../tools/sync-npmmirror.mjs'

const checksum = createHash('sha1').update('archive').digest('hex')
const tarball = 'https://registry.npmmirror.com/heybash-xdpool/-/heybash-xdpool-1.0.3.tgz'
const doc = (version = '1.0.3', hash = checksum) => ({
  'dist-tags': { latest: version },
  versions: { [version]: { dist: { shasum: hash, tarball } } },
})
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })
const options = { sleep: async () => {}, log: () => {}, attempts: 3, intervalMs: 0, syncAttempts: 2 }

describe('npm mirror synchronization', () => {
  it('does not create a task when the version, checksum, tag, and tarball match', async () => {
    const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === 'HEAD') return new Response(null, { status: 200 })
      return json(doc())
    })
    await expect(syncMirror({ ...options, fetchImpl: fetcher })).resolves.toEqual({ version: '1.0.3', synced: false })
    expect(fetcher.mock.calls.some(([, init]) => init?.method === 'PUT')).toBe(false)
    expect(fetcher.mock.calls.some(([, init]) => new Headers(init?.headers).has('cache-control'))).toBe(false)
    expect(new Headers(fetcher.mock.calls[0]?.[1]?.headers).get('accept')).toBe('application/json')
  })

  it('waits for npm, triggers synchronization, and waits for the mirror to serve the version', async () => {
    let officialReads = 0
    let mirrorReads = 0
    const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes('registry.npmjs.org')) return ++officialReads === 1 ? json({}, 404) : json(doc())
      if (init?.method === 'PUT') return json({ ok: true, id: 'task1' })
      if (url.endsWith('/syncs/task1')) return json({ state: 'success' })
      if (init?.method === 'HEAD') return new Response(null, { status: 200 })
      if (url === tarball) return new Response('archive')
      return json(++mirrorReads < 3 ? doc('1.0.2') : doc())
    })
    await expect(syncMirror({ ...options, version: '1.0.3', fetchImpl: fetcher })).resolves.toEqual({ version: '1.0.3', synced: true })
    expect(officialReads).toBe(2)
    expect(fetcher.mock.calls.filter(([, init]) => init?.method === 'PUT')).toHaveLength(1)
  })

  it('allows npm publication to take longer than the mirror retry window', async () => {
    let officialReads = 0
    const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes('registry.npmjs.org')) return ++officialReads < 5 ? json({}, 404) : json(doc())
      if (init?.method === 'HEAD') return new Response(null, { status: 200 })
      return json(doc())
    })
    await expect(syncMirror({ ...options, version: '1.0.3', fetchImpl: fetcher })).resolves.toEqual({ version: '1.0.3', synced: false })
    expect(officialReads).toBe(5)
  })

  it('retries failed mirror tasks and reports failure rather than false success', async () => {
    const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes('registry.npmjs.org')) return json(doc())
      if (init?.method === 'PUT') return json({ ok: true, id: 'task1' })
      if (url.endsWith('/syncs/task1')) return json({ state: 'fail' })
      return json(doc('1.0.2'))
    })
    await expect(syncMirror({ ...options, fetchImpl: fetcher })).rejects.toThrow('Mirror synchronization failed')
    expect(fetcher.mock.calls.filter(([, init]) => init?.method === 'PUT')).toHaveLength(2)
  })

  it('accepts a verified mirror after a sync task fails without submitting another task', async () => {
    let mirrorReads = 0
    const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes('registry.npmjs.org')) return json(doc())
      if (init?.method === 'PUT') return json({ ok: true, id: 'task1' })
      if (url.endsWith('/syncs/task1')) return json({ state: 'fail' })
      if (url === tarball) return new Response('archive')
      return json(++mirrorReads === 1 ? doc('1.0.2') : doc())
    })
    await expect(syncMirror({ ...options, fetchImpl: fetcher })).resolves.toEqual({ version: '1.0.3', synced: true })
    expect(fetcher.mock.calls.filter(([, init]) => init?.method === 'PUT')).toHaveLength(1)
  })

  it('does not report success for a matching version with the wrong checksum or missing tarball', async () => {
    let mode: 'checksum' | 'tarball' = 'checksum'
    const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes('registry.npmjs.org')) return json(doc())
      if (init?.method === 'PUT') return json({ ok: true, id: 'task1' })
      if (url.endsWith('/syncs/task1')) return json({ state: 'success' })
      if (init?.method === 'HEAD') return new Response(null, { status: 404 })
      if (url === tarball) return new Response(null, { status: 404 })
      return json(doc('1.0.3', mode === 'checksum' ? 'b'.repeat(40) : checksum))
    })
    await expect(syncMirror({ ...options, fetchImpl: fetcher })).rejects.toThrow('Mirror synchronization failed')
    mode = 'tarball'
    await expect(syncMirror({ ...options, fetchImpl: fetcher })).rejects.toThrow('Mirror synchronization failed')
  })

  it('detects corrupt downloaded bytes even when metadata reports the correct checksum', async () => {
    const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes('registry.npmjs.org')) return json(doc())
      if (init?.method === 'PUT') return json({ ok: true, id: 'task1' })
      if (url.endsWith('/syncs/task1')) return json({ state: 'success' })
      if (init?.method === 'HEAD') return new Response(null, { status: 404 })
      if (url === tarball) return new Response('corrupt archive')
      return json(doc())
    })
    await expect(syncMirror({ ...options, fetchImpl: fetcher })).rejects.toThrow('tarball checksum does not match npm')
  })

  it('rejects unexpected versions without making network requests', async () => {
    const fetcher = vi.fn()
    await expect(syncMirror({ ...options, version: '../other', fetchImpl: fetcher })).rejects.toThrow('Invalid target version')
    expect(fetcher).not.toHaveBeenCalled()
  })
})
