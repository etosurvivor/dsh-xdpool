import { randomBytes } from 'node:crypto'
import { closeSync, mkdirSync, openSync, readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

/** Cross-process state for account/model routing. No message content is stored. */
export class ComboRouteState {
  private readonly db: DatabaseSync
  private readonly owner = `${process.pid}:${randomBytes(16).toString('hex')}`
  private readonly limit = 5000

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    const database = `${path}.sqlite`
    try { const fd = openSync(database, 'wx', 0o600); closeSync(fd) } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
    this.db = new DatabaseSync(database)
    this.db.exec('PRAGMA busy_timeout = 5000')
    // Changing journal mode can return SQLITE_BUSY immediately even with a
    // busy timeout when two hosts open a brand-new database simultaneously.
    const deadline = Date.now() + 5000
    for (;;) {
      try { this.db.exec('PRAGMA journal_mode = WAL'); break } catch (error) {
        const code = (error as { errcode?: number }).errcode
        if ((code !== 5 && code !== 6) || Date.now() >= deadline) { this.db.close(); throw error }
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20)
      }
    }
    this.db.exec('CREATE TABLE IF NOT EXISTS bindings (key TEXT PRIMARY KEY, member TEXT NOT NULL, account TEXT); CREATE TABLE IF NOT EXISTS recent (key TEXT PRIMARY KEY, at INTEGER NOT NULL); CREATE TABLE IF NOT EXISTS session_locks (key TEXT PRIMARY KEY, owner TEXT NOT NULL, pid INTEGER NOT NULL); CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);')
    this.transaction(() => {
      if (this.db.prepare("SELECT value FROM metadata WHERE key = 'legacy_imported'").get() !== undefined) return
      try {
        const legacy = JSON.parse(readFileSync(path, 'utf8')) as { bindings?: Record<string, unknown>; accounts?: Record<string, unknown>; lastUsed?: Record<string, unknown> }
        if (legacy.bindings !== null && typeof legacy.bindings === 'object' && !Array.isArray(legacy.bindings)) {
          for (const [key, member] of Object.entries(legacy.bindings).slice(-this.limit)) {
            const account = legacy.accounts?.[key]
            if (key.length <= 1100 && typeof member === 'string' && member.length > 0 && member.length <= 1024) {
              this.db.prepare('INSERT OR IGNORE INTO bindings VALUES (?, ?, ?)').run(key, member, typeof account === 'string' && account.length <= 1024 ? account : null)
            }
          }
        }
        if (legacy.lastUsed !== null && typeof legacy.lastUsed === 'object' && !Array.isArray(legacy.lastUsed)) {
          for (const [key, at] of Object.entries(legacy.lastUsed).slice(-this.limit)) {
            if (key.length <= 2200 && typeof at === 'number' && Number.isSafeInteger(at) && at >= 0) this.db.prepare('INSERT OR IGNORE INTO recent VALUES (?, ?)').run(key, at)
          }
        }
      } catch { /* No usable legacy file. */ }
      this.db.prepare("INSERT INTO metadata VALUES ('legacy_imported', '1')").run()
    })
  }

  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE')
    try { const result = fn(); this.db.exec('COMMIT'); return result } catch (error) { this.db.exec('ROLLBACK'); throw error }
  }

  binding(key: string): { member: string; accountId?: string; confirmed: true } | undefined {
    const row = this.db.prepare('SELECT member, account FROM bindings WHERE key = ?').get(key) as { member: string; account: string | null } | undefined
    return row === undefined ? undefined : { member: row.member, confirmed: true, ...(row.account === null ? {} : { accountId: row.account }) }
  }

  setBinding(key: string, member: string, accountId?: string): void {
    this.db.prepare('DELETE FROM bindings WHERE key = ?').run(key)
    this.db.prepare('INSERT INTO bindings VALUES (?, ?, ?)').run(key, member, accountId ?? null)
    this.db.exec(`DELETE FROM bindings WHERE rowid IN (SELECT rowid FROM bindings ORDER BY rowid DESC LIMIT -1 OFFSET ${this.limit})`)
  }

  deleteBinding(key: string): void { this.db.prepare('DELETE FROM bindings WHERE key = ?').run(key) }

  recent(): Map<string, number> {
    return new Map((this.db.prepare('SELECT key, at FROM recent ORDER BY at').all() as { key: string; at: number }[]).map(row => [row.key, row.at]))
  }

  touch(key: string): number {
    const row = this.db.prepare('SELECT MAX(at) AS latest FROM recent').get() as { latest: number | null }
    const at = Math.max(Date.now(), (row.latest ?? 0) + 1)
    this.db.prepare('INSERT INTO recent VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET at=excluded.at').run(key, at)
    this.db.exec(`DELETE FROM recent WHERE key IN (SELECT key FROM recent ORDER BY at DESC LIMIT -1 OFFSET ${this.limit})`)
    return at
  }

  async lockSession(key: string, signal: AbortSignal): Promise<() => void> {
    while (!signal.aborted) {
      const acquired = this.transaction(() => {
        const row = this.db.prepare('SELECT owner, pid FROM session_locks WHERE key = ?').get(key) as { owner: string; pid: number } | undefined
        if (row !== undefined) {
          let alive = true
          try { process.kill(row.pid, 0) } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') alive = false }
          if (alive) return false
          this.db.prepare('DELETE FROM session_locks WHERE key = ? AND owner = ?').run(key, row.owner)
        }
        this.db.prepare('INSERT INTO session_locks VALUES (?, ?, ?)').run(key, this.owner, process.pid)
        return true
      })
      if (acquired) return () => { this.db.prepare('DELETE FROM session_locks WHERE key = ? AND owner = ?').run(key, this.owner) }
      await new Promise<void>(resolve => {
        const done = (): void => { clearTimeout(timer); signal.removeEventListener('abort', done); resolve() }
        const timer = setTimeout(done, 30)
        signal.addEventListener('abort', done, { once: true })
        if (signal.aborted) done()
      })
    }
    throw new Error('routing request cancelled while waiting for session lock')
  }
  close(): void { this.db.close() }
}
