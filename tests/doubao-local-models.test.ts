import { describe, expect, it } from 'vitest'
import { parseDoubaoModelPreferences } from '../src/doubao-local-models.ts'

const fixture = (items: unknown) => JSON.stringify({ saman: { local_storage_for_web: { 'frontend-request-cache': JSON.stringify({ _DesktopActionBarBriefListRequestCacheDataV1: { data: { modeSelectData: { menuConfV2: { model_list: { item_list: items } } } } } }) } } })
describe('Doubao client model menu', () => {
  it('extracts menu names, modes, exact rates and per-model effort levels', () => {
    const rows = parseDoubaoModelPreferences(fixture([
      { model_item_key: 'person-deepseek-v4-1-flash-261017', name: 'DeepSeek V4.1 Flash', default_mode: '3', tag_list: [{ text: '限时优惠 0.01x' }], reasoning_effort_config: { option_list: [{ level: 3, name: '低' }, { level: 7, name: '最高' }] } },
      { model_item_key: '0', name: '豆包 快速', default_mode: '1' },
    ]))
    expect(rows).toEqual([
      { id: 'person-deepseek-v4-1-flash-261017', name: 'DeepSeek V4.1 Flash', mode: 'work', rate: '限时优惠 0.01x', reasoning: [{ level: 3, name: '低' }, { level: 7, name: '最高' }] },
      { id: '0', name: '豆包 快速', mode: 'chat' },
    ])
  })
  it('does not infer a mode or expose unrelated profile data', () => {
    expect(parseDoubaoModelPreferences(fixture([{ model_item_key: 'x', name: 'X', default_mode: '9', secret: 'not a model field' }]))).toEqual([{ id: 'x', name: 'X', mode: 'unknown' }])
  })
  it('deduplicates model IDs and handles malformed or missing menu data', () => {
    expect(parseDoubaoModelPreferences(fixture([{ model_item_key: '3', name: 'Turbo' }, { model_item_key: '3', name: 'duplicate' }, { model_item_key: 'bad key!', name: 'bad' }]))).toHaveLength(1)
    expect(parseDoubaoModelPreferences('broken')).toEqual([])
    expect(parseDoubaoModelPreferences('{}')).toEqual([])
  })
})
