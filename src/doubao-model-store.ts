import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { pluginDataDir } from './ignored.ts'
import { discoverDoubaoLocalModels, type LocalDoubaoModel } from './doubao-local-models.ts'

const fallback: readonly LocalDoubaoModel[] = [
  { id: '0', name: '豆包 快速', mode: 'chat' },
  { id: '3', name: '豆包 2.1 Turbo', mode: 'chat' },
  { id: 'seed-lite-7b', name: '豆包 2.1 Lite', mode: 'work' },
  { id: '5', name: '豆包 2.1 Pro', mode: 'work' },
  { id: '9', name: '自动', mode: 'work' },
  { id: 'image-gen', name: '豆包 生图', mode: 'chat' },
]
/** Never merge unknown-mode entries: their actual routing is not known. */
export function doubaoModelCatalog(local: readonly LocalDoubaoModel[] = discoverDoubaoLocalModels()): LocalDoubaoModel[] {
  const entries = new Map(fallback.map(model => [model.id, model]))
  for (const model of local) {
    if (model.mode === 'unknown') continue
    entries.set(model.id, model)
  }
  return [...entries.values()]
}
export class DoubaoModelStore {
  private disabled = new Set<string>()
  private pending: Promise<void> = Promise.resolve()
  constructor(private readonly path = join(pluginDataDir(), 'doubao-model-selection.json')) {}
  async load(): Promise<void> {
    try {
      const value: unknown = JSON.parse(await readFile(this.path, 'utf8'))
      const disabled = (value as { disabled?: unknown } | null)?.disabled
      if (!Array.isArray(disabled) || !disabled.every(id => typeof id === 'string' && /^[\w.-]{1,64}$/u.test(id))) throw new Error('invalid model selection')
      this.disabled = new Set(disabled)
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw new Error('豆包模型选择配置损坏，无法读取')
    }
  }
  isEnabled(id: string): boolean { return !this.disabled.has(id) }
  disabledIds(): string[] { return [...this.disabled] }
  /** Serialize whole-list updates and publish only after the durable write succeeds. */
  async setDisabled(ids: readonly string[]): Promise<void> {
    if (ids.length > 200 || ids.some(id => !/^[\w.-]{1,64}$/u.test(id))) throw new Error('模型选择无效')
    const next = [...new Set(ids)]
    const task = this.pending.then(async () => {
      await mkdir(dirname(this.path), { recursive: true, mode: 0o700 })
      const temp = `${this.path}.${randomUUID()}.tmp`
      try { await writeFile(temp, JSON.stringify({ disabled: next }), { encoding: 'utf8', mode: 0o600, flag: 'wx' }); await rename(temp, this.path) }
      finally { await unlink(temp).catch(() => {}) }
      this.disabled = new Set(next)
    })
    this.pending = task.catch(() => {})
    await task
  }
}
