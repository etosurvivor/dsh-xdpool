import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import { doubaoModelCatalog, DoubaoModelStore } from '../src/doubao-model-store.ts'

describe('Doubao model selection', () => {
  it('merges discovered menu models without inventing modes', () => {
    const catalog = doubaoModelCatalog([{ id: 'person-deepseek', name: 'DeepSeek', mode: 'work' }, { id: 'unknown', name: 'Unknown', mode: 'unknown' }])
    expect(catalog.find(row => row.id === 'person-deepseek')?.mode).toBe('work')
    expect(catalog.some(row => row.id === 'unknown')).toBe(false)
  })
  it('persists disabled models, including an all-off selection, across reloads', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'doubao-models-'))
    try {
      const path = join(dir, 'selection.json'), store = new DoubaoModelStore(path)
      await store.load(); expect(store.isEnabled('0')).toBe(true)
      await store.setDisabled(['0', '3'])
      const reopened = new DoubaoModelStore(path); await reopened.load()
      expect(reopened.isEnabled('0')).toBe(false); expect(reopened.isEnabled('3')).toBe(false)
      expect(reopened.isEnabled('new-model')).toBe(true)
      await reopened.setDisabled([]); expect(reopened.isEnabled('0')).toBe(true)
      expect(JSON.parse(await readFile(path, 'utf8')).disabled).toEqual([])
    } finally { await rm(dir, { recursive: true, force: true }) }
  })
  it('rejects corrupt settings and invalid identifiers instead of enabling models silently', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'doubao-models-'))
    try {
      const path = join(dir, 'selection.json'); await writeFile(path, '{bad')
      await expect(new DoubaoModelStore(path).load()).rejects.toThrow('配置损坏')
      await expect(new DoubaoModelStore(path).setDisabled(['bad id'])).rejects.toThrow('无效')
    } finally { await rm(dir, { recursive: true, force: true }) }
  })
})
