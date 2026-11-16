/** Read the model menu saved by Doubao Work. Menu presence does not prove routing. */
import { readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export interface LocalDoubaoModel {
  id: string
  name: string
  /** The client's declared mode. Missing/unknown modes are never guessed. */
  mode: 'chat' | 'work' | 'unknown'
  rate?: string
  reasoning?: readonly { level: number; name: string }[]
}
const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined

/** Parse only the documented menu path; never return other profile contents. */
export function parseDoubaoModelPreferences(raw: string): LocalDoubaoModel[] {
  try {
    const prefs = record(JSON.parse(raw))
    const saman = record(prefs?.['saman'])
    const local = record(saman?.['local_storage_for_web'])
    const cached = local?.['frontend-request-cache']
    if (typeof cached !== 'string') return []
    const root = record(JSON.parse(cached))
    const entry = record(root?.['_DesktopActionBarBriefListRequestCacheDataV1'])
    const data = record(entry?.['data'])
    const mode = record(data?.['modeSelectData'])
    const menu = record(mode?.['menuConfV2'])
    const list = record(menu?.['model_list'])?.['item_list']
    if (!Array.isArray(list)) return []
    const out: LocalDoubaoModel[] = []
    const seen = new Set<string>()
    for (const value of list) {
      const row = record(value)
      const id = row?.['model_item_key']
      const name = row?.['name']
      if (typeof id !== 'string' || !/^[\w.-]{1,64}$/u.test(id) || typeof name !== 'string' || name.trim() === '' || name.length > 100 || seen.has(id)) continue
      seen.add(id)
      const sourceMode = row?.['default_mode']
      const modeValue = sourceMode === '1' ? 'chat' : sourceMode === '3' ? 'work' : 'unknown'
      const tags = row?.['tag_list']
      const rate = Array.isArray(tags) ? tags.map(tag => record(tag)?.['text']).find(text => typeof text === 'string' && text.trim() !== '') : undefined
      const opts = record(row?.['reasoning_effort_config'])?.['option_list']
      const levels: { level: number; name: string }[] = []
      if (Array.isArray(opts)) for (const candidate of opts) {
        const option = record(candidate), level = option?.['level'], label = option?.['name']
        if (typeof level === 'number' && Number.isSafeInteger(level) && typeof label === 'string' && label.trim() !== '' && !levels.some(item => item.level === level)) levels.push({ level, name: label })
      }
      out.push({ id, name, mode: modeValue, ...(typeof rate === 'string' ? { rate } : {}), ...(levels.length ? { reasoning: levels } : {}) })
    }
    return out
  } catch { return [] }
}

/** Read a local client menu as an optional hint; never access cookies or session files. */
export function discoverDoubaoLocalModels(options: { paths?: readonly string[] } = {}): LocalDoubaoModel[] {
  const local = process.env['LOCALAPPDATA'], roaming = process.env['APPDATA']
  const dirs = options.paths ?? [
    join(homedir(), 'Library', 'Application Support', 'DoubaoWork', 'Default', 'Preferences'),
    join(homedir(), 'Library', 'Application Support', 'Doubao', 'Default', 'Preferences'),
    ...(local ? [join(local, 'Doubao', 'User Data', 'Default', 'Preferences'), join(local, 'DoubaoWork', 'User Data', 'Default', 'Preferences')] : []),
    ...(roaming ? [join(roaming, 'Doubao', 'Default', 'Preferences'), join(roaming, 'DoubaoWork', 'Default', 'Preferences')] : []),
  ]
  for (const path of dirs) {
    try {
      if (statSync(path).size > 16 * 1024 * 1024) continue
      const models = parseDoubaoModelPreferences(readFileSync(path, 'utf8'))
      if (models.length > 0) return models
    } catch { /* optional local app is absent or unreadable */ }
  }
  return []
}
