import { createElement, type ComponentType } from 'react'
import type { StoredEntry } from '@deepseek-ai/dsh-client-ui-slots'
import { useRouteReading, useSelectedChain, type ModelDirectoryStore } from './RouteLastUsed.tsx'

const DOCK = 'conversation.composer.dock'
const EMPTY_STATS = { turns: 0, steps: 0, llmMs: 0, toolMs: 0, ttftMs: 0, ttftSteps: 0 }

interface ActivityProps {
  sessionId: string
  useProjection: (key: string) => unknown
}

interface Slots {
  entries?: (name: string) => readonly StoredEntry[]
  subscribe?: (name: string, update: () => void) => () => void
  register(options: Record<string, unknown>, component: unknown): () => void
}

/** Use the host's activity control with the routed model's measured speed. */
export function installRouteActivity(slots: Slots, directoryFor: (sessionId: string) => ModelDirectoryStore | undefined): () => void {
  let native: StoredEntry | undefined
  let dispose: (() => void) | undefined
  const update = (): void => {
    const entry = slots.entries?.(DOCK).find(item => item.options.id === 'activity'
      && item.options.order === 0 && (item.options.priority ?? 0) === 0)
    if (entry === native) return
    dispose?.()
    native = entry
    dispose = undefined
    if (entry === undefined) return
    const Activity = entry.component as ComponentType<ActivityProps>
    function RouteActivity(props: ActivityProps) {
      const chain = useSelectedChain(directoryFor(props.sessionId))
      const decode = useRouteReading(props.sessionId, chain)?.decode
      if (chain === undefined) return createElement(Activity, props)
      function useRouteProjection(key: string): unknown {
        const value = props.useProjection(key)
        if (key !== 'sessionStats') return value
        return {
          ...EMPTY_STATS,
          ...(value !== null && typeof value === 'object' ? value : {}),
          decodeMs: decode?.decodeMs ?? 0,
          decodeTokens: decode?.decodeTokens ?? 0,
        }
      }
      return createElement(Activity, { ...props, useProjection: useRouteProjection })
    }
    dispose = slots.register({
      name: DOCK, id: 'activity', order: 0, priority: -1, locale: entry.locale, inject: entry.inject,
    }, RouteActivity)
  }
  const unsubscribe = slots.subscribe?.(DOCK, update)
  update()
  return () => { unsubscribe?.(); dispose?.() }
}
