import { describe, expect, it } from 'vitest'
import { ChainRow, draftContextWindow, draftOf } from '../src/client/RoutingPage.tsx'
import type { PoolWebComboCandidate } from '../src/status-paths.ts'

const candidate = (id: string, contextWindow: number): PoolWebComboCandidate => ({ id, contextWindow, name: id, owner: 'provider', usable: true, supportsImages: false, siblings: [] })
const candidates = new Map([['a', candidate('a', 1_000_000)], ['b', candidate('b', 400_000)], ['c', candidate('c', 1_048_576)]])
const textOf = (node: unknown): string => {
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  if (node !== null && typeof node === 'object' && 'props' in node) return textOf((node as { props: { children?: unknown } }).props.children)
  return ''
}
const combo = { id: 'combo:test', name: 'test', models: ['a', 'b', 'c'], platforms: [{ owner: 'workbuddy', models: ['a', 'b', 'c'] }], missing: [], strategy: 'fallback' as const, stickyLimit: 1, enabled: true, contextWindow: 400_000, supportsImages: false }

describe('route context display', () => {
  it('renders the saved minimum and makes a changed value explicitly a preview', () => {
    const draft = draftOf(combo)
    const render = (editable: boolean) => textOf(ChainRow({ draft, editable, preview: editable, candidateById: candidates, onEdit: () => {}, onDelete: () => {} }))
    expect(render(false)).toContain('Context 400K')
    draft.flat = ['a', 'c']
    expect(render(true)).toContain('Context preview 1M (save to apply)')
  })
  it('keeps unknown members out of the displayed minimum and handles no available members', () => {
    expect(draftContextWindow(['a', 'missing'], candidates)).toBe(1_000_000)
    expect(draftContextWindow(['missing'], candidates)).toBeUndefined()
  })
})
