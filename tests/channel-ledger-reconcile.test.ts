import { describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { reconcileChannelLedger } from '../src/credit-report.ts'
import { UsageRecorder } from '../src/stats.ts'

describe('channel usage reconciliation', () => {
  it('includes direct and child usage without adding overlapping route calls twice', () => {
    const home = mkdtempSync(join(tmpdir(), 'xdpool-ledger-'))
    try {
      mkdirSync(join(home, 'channel-pack'))
      writeFileSync(join(home, 'channel-pack', 'token-ledger.json'), JSON.stringify({ days: {
        '2026-11-17': {
          'direct|trae|a|flash': { requests: 3, reportedRequests: 3, inputTokens: 100, outputTokens: 50, cacheReadTokens: 20, reasoningTokens: 5 },
          'direct|trae|b|flash': { requests: 2, reportedRequests: 2, inputTokens: 10, outputTokens: 7 },
          'gateway|trae|a|flash': { requests: 100, reportedRequests: 100, inputTokens: 9000, outputTokens: 9000 },
        },
      } }))
      const recorder = new UsageRecorder()
      recorder.record({ channel: 'trae', region: '', model: 'flash', turnId: 'main', at: Date.parse('2026-11-17T02:00:00Z'), ok: true,
        usage: { inputTokens: 15, outputTokens: 4, cachedTokens: 3, reasoningTokens: 1 } })
      recorder.record({ channel: 'trae', region: '', model: 'flash', turnId: 'child', at: Date.parse('2026-11-17T02:01:00Z'), ok: true,
        usage: { inputTokens: 15, outputTokens: 4, cachedTokens: 3, reasoningTokens: 1 } })
      const result = reconcileChannelLedger(home, recorder.summary(), new Set(['trae']), Date.parse('2026-11-17T03:00:00Z'))
      expect(result.calls).toBe(5)
      expect(result.rows).toHaveLength(1)
      expect(result.rows[0]).toMatchObject({ channel: 'trae', model: 'flash', calls: 5,
        inputTokens: 130, outputTokens: 57, cachedTokens: 20, reasoningTokens: 5 })
      expect(result.turns).toBe(2) // daily totals cannot reconstruct individual turns
    } finally { rmSync(home, { recursive: true, force: true }) }
  })

  it('keeps the latest in-memory result while the ledger flush is pending', () => {
    const home = mkdtempSync(join(tmpdir(), 'xdpool-ledger-'))
    try {
      mkdirSync(join(home, 'channel-pack'))
      writeFileSync(join(home, 'channel-pack', 'token-ledger.json'), JSON.stringify({ days: {
        '2026-11-17': { 'direct|trae|a|flash': { requests: 1, reportedRequests: 1, inputTokens: 4, outputTokens: 3 } },
      } }))
      const recorder = new UsageRecorder()
      recorder.record({ channel: 'trae', region: '', model: 'flash', turnId: 'a', at: Date.parse('2026-11-17T02:00:00Z'), ok: true,
        usage: { inputTokens: 10, outputTokens: 8, cachedTokens: 0, reasoningTokens: 0 } })
      expect(reconcileChannelLedger(home, recorder.summary(), new Set(['trae']), Date.parse('2026-11-17T03:00:00Z')).rows[0])
        .toMatchObject({ inputTokens: 10, outputTokens: 8 })
    } finally { rmSync(home, { recursive: true, force: true }) }
  })

  it('does not mix yesterday’s retained channel usage into today’s ledger', () => {
    const home = mkdtempSync(join(tmpdir(), 'xdpool-ledger-'))
    try {
      mkdirSync(join(home, 'channel-pack'))
      writeFileSync(join(home, 'channel-pack', 'token-ledger.json'), JSON.stringify({ days: {
        '2026-11-17': { 'direct|trae|a|flash': { requests: 1, reportedRequests: 1, inputTokens: 10, outputTokens: 3 } },
      } }))
      const recorder = new UsageRecorder()
      recorder.record({ channel: 'trae', region: '', model: 'flash', turnId: 'old', at: Date.parse('2026-11-16T15:59:00Z'), ok: true,
        usage: { inputTokens: 1000, outputTokens: 300, cachedTokens: 0, reasoningTokens: 0 } })
      const result = reconcileChannelLedger(home, recorder.summary(), new Set(['trae']), Date.parse('2026-11-16T16:05:00Z'))
      expect(result.rows[0]).toMatchObject({ inputTokens: 10, outputTokens: 3, calls: 1 })
      expect(result.entries).toHaveLength(0)
    } finally { rmSync(home, { recursive: true, force: true }) }
  })

  it('keeps a retry and its successful fallback together across midnight', () => {
    const home = mkdtempSync(join(tmpdir(), 'xdpool-ledger-'))
    try {
      mkdirSync(join(home, 'channel-pack'))
      writeFileSync(join(home, 'channel-pack', 'token-ledger.json'), JSON.stringify({ days: {
        '2026-11-18': { 'direct|trae|a|flash': { requests: 2, reportedRequests: 2, inputTokens: 20, outputTokens: 6 } },
      } }))
      const recorder = new UsageRecorder()
      const before = Date.parse('2026-11-17T15:59:59Z')
      const after = Date.parse('2026-11-17T16:00:01Z')
      recorder.record({ channel: 'workbuddy', region: 'cn', model: 'flash', turnId: 'old', at: before - 1, ok: false })
      recorder.record({ channel: 'trae', region: '', model: 'flash', turnId: 'old', at: before, ok: true })
      recorder.record({ channel: 'trae', region: '', model: 'flash', turnId: 'spans', at: before, ok: false })
      recorder.record({ channel: 'workbuddy', region: 'cn', model: 'flash', turnId: 'spans', at: before, ok: false })
      recorder.record({ channel: 'trae', region: '', model: 'flash', turnId: 'spans', at: after, ok: true,
        usage: { inputTokens: 10, outputTokens: 3, cachedTokens: 0, reasoningTokens: 0 } })
      const result = reconcileChannelLedger(home, recorder.summary(), new Set(['trae']), after)
      expect(result).toMatchObject({ turns: 1, recoveredTurns: 1, failedTurns: 0, calls: 4 })
      expect(result.entries.map(entry => entry.turnId)).toEqual(['spans', 'spans', 'spans'])
      expect(result.rows.find(row => row.channel === 'trae')).toMatchObject({ calls: 3, failed: 1, inputTokens: 20 })
      expect(result.rows.find(row => row.channel === 'workbuddy')).toMatchObject({ calls: 1, failed: 1 })
    } finally { rmSync(home, { recursive: true, force: true }) }
  })
})
