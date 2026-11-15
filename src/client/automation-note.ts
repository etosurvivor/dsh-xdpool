import type { XdPoolSettingsKey } from './locales.ts'
import type { PoolWebAutomationItem, PoolWebAutomationItemStatus } from '../status-paths.ts'

type Translate = (key: XdPoolSettingsKey, params?: Record<string, unknown>) => string

/** Localize known scheduler reasons; preserve upstream error details verbatim. */
export function automationNote(note: string, t?: Translate): string {
  const keys: Record<string, XdPoolSettingsKey> = {
    'not covered by automation': 'row.autoNote.uncovered',
    'automatic completion failed': 'row.autoNote.failed',
    'not scored yet': 'row.autoNote.unscored',
    'not accepted': 'row.autoNote.notAccepted',
    locked: 'row.autoNote.locked',
  }
  const key = keys[note]
  return key === undefined ? note : (t?.(key) ?? note)
}

/** Show unsupported tasks separately from supported tasks awaiting scoring. */
export function automationGroup(item: PoolWebAutomationItem): PoolWebAutomationItemStatus | 'uncovered' {
  return item.status === 'skipped' && item.note === 'not covered by automation' ? 'uncovered' : item.status
}
