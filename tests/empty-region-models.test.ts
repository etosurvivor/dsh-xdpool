import { describe, expect, it, vi } from 'vitest'
import { WorkBuddyCatalog } from '../src/catalog.ts'

vi.mock('@deepseek-ai/dsh-llm-pi-ai', () => ({ PiAiAdapter: class {} }))
vi.mock('@deepseek-ai/dsh-llm', () => ({ resolveImageAttachmentAccess: () => {}, resolveRetryPolicy: () => ({}) }))
vi.mock('@earendil-works/pi-ai', () => ({ createProvider: (input: unknown) => input }))
vi.mock('@earendil-works/pi-ai/api/openai-completions.lazy', () => ({ openAICompletionsApi: () => ({}) }))
import { createWorkBuddyAdapter, visiblePoolModels } from '../src/adapter.ts'

describe('pool model visibility without an account', () => {
  it('hides a region with no accounts and restores its saved selection when one is added', () => {
    const catalog = new WorkBuddyCatalog('global')
    const [first, second] = catalog.current()
    expect(first).toBeDefined(); expect(second).toBeDefined()
    catalog.applySelection({ enabledModelIds: [first!.id] })
    let hasAccount = false
    const adapter = createWorkBuddyAdapter({ catalog, shim: { baseUrl: () => 'http://127.0.0.1', token: () => 'test' } as never, ctx: {} as never, hasAccount: () => hasAccount })
    expect(adapter.buildModels()).toEqual([])
    expect(visiblePoolModels(catalog, hasAccount)).toEqual([])
    expect(catalog.currentSelection().enabledModelIds).toEqual([first!.id])
    hasAccount = true
    expect(adapter.buildModels().map(model => model.id)).toEqual([first!.id])
    expect(visiblePoolModels(catalog, hasAccount).map(model => model.id)).toEqual([first!.id])
    hasAccount = false
    expect(adapter.buildModels()).toEqual([])
  })
  it('does not hide a connected region when its live catalog falls back', () => {
    const catalog = new WorkBuddyCatalog('cn')
    expect(visiblePoolModels(catalog, true).length).toBeGreaterThan(0)
    expect(visiblePoolModels(catalog, false)).toEqual([])
  })
})
