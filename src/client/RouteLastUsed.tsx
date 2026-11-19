import { useEffect, useState, useSyncExternalStore, type ReactElement } from 'react'
import type { RouteReading } from '../route-stream.ts'
import { POOL_ROUTE_LAST_USED_PATH } from '../status-paths.ts'

interface ModelSelection { provider?: string; model?: string }
interface DirectorySnapshot { current?: ModelSelection | null }
export interface ModelDirectoryStore {
  subscribe(listener: () => void): () => void
  getSnapshot(): DirectorySnapshot
}
const EMPTY_SNAPSHOT: DirectorySnapshot = {}
const EMPTY_DIRECTORY: ModelDirectoryStore = { subscribe: () => () => {}, getSnapshot: () => EMPTY_SNAPSHOT }
export function useSelectedChain(directory: ModelDirectoryStore | undefined): string | undefined {
  const store = directory ?? EMPTY_DIRECTORY
  const selection = useSyncExternalStore(listener => store.subscribe(listener), () => store.getSnapshot(), () => store.getSnapshot()).current
  return selection?.provider === 'xdpool-aggregate' && selection.model?.startsWith('combo:') === true
    ? selection.model : undefined
}

export function useRouteReading(sessionId: string, chain: string | undefined): RouteReading | undefined {
  const [result, setResult] = useState<{ key: string; value: RouteReading } | undefined>()
  const key = `${sessionId}\0${chain ?? ''}`
  useEffect(() => {
    if (chain === undefined || sessionId === '') return
    let active = true
    const controller = new AbortController()
    let busy = false
    const load = async (): Promise<void> => {
      if (busy) return
      busy = true
      try {
        const params = new URLSearchParams({ session: sessionId, chain })
        const response = await fetch(`${POOL_ROUTE_LAST_USED_PATH}?${params.toString()}`, { signal: controller.signal, headers: { accept: 'application/json' } })
        const value = response.ok ? await response.json() as { route?: RouteReading | null } : undefined
        const route = value?.route
        if (!active) return
        if (typeof route?.channel === 'string' && typeof route.model === 'string') {
          setResult({ key, value: route })
        } else setResult(undefined)
      } catch { if (active) setResult(undefined) } finally { busy = false }
    }
    void load()
    const timer = window.setInterval(() => { void load() }, 2000)
    return () => { active = false; controller.abort(); window.clearInterval(timer) }
  }, [sessionId, chain, key])
  return chain !== undefined && result?.key === key ? result.value : undefined
}

export function RouteLastUsed({ sessionId, directory, useSession }: {
  sessionId: string
  directory?: ModelDirectoryStore | undefined
  useSession: <T>(selector: (value: { subagent?: unknown }) => T) => T
}): ReactElement | null {
  const chain = useSelectedChain(directory)
  const isChild = useSession(value => value.subagent != null)
  const route = useRouteReading(sessionId, isChild ? undefined : chain)
  if (route === undefined) return null
  const label = `${route.channel} · ${route.model}`
  return <span className="dsm-xdpool-route-last-used" title={label} aria-label={label}>
    <style>{'.dsm-xdpool-route-last-used{color:var(--dsw-alias-label-secondary,#68707b);font-size:11px;line-height:20px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:min(280px,36vw)}'}</style>
    {label}
  </span>
}
