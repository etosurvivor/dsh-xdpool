import { createHash, randomUUID } from 'node:crypto'
import { mkdir, open, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { DoubaoWorkAdapter, DOUBAO_WORK_PROVIDER } from './doubao-work-adapter.ts'
import { importLocalDoubaoWorkSession, type DoubaoWorkSession } from './doubao-work-auth.ts'
import { doubaoPost } from './doubao-work-direct.ts'
import { checkInDoubaoWork, type RewardOutcome } from './doubao-work-rewards.ts'
import { parseDoubaoQuota, type DoubaoQuota } from './doubao-work-quota.ts'
import { pluginDataDir } from './ignored.ts'

const ref = credentialRef('HEYBASH_DOUBAO_WORK_SESSION')
export const DOUBAO_WORK_PATH = '/api/xdpool/doubao-work'
type State = { version: 1; pendingDay?: string; checkedDay?: string; account?: string }
const day = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date())
const statePath = () => join(pluginDataDir(), 'doubao-work-reward-state.json')
async function loadState(): Promise<State> {
  try {
    const value: unknown = JSON.parse(await readFile(statePath(), 'utf8'))
    if (!value || typeof value !== 'object' || (value as State).version !== 1) throw new Error('invalid')
    return value as State
  } catch (error: any) {
    if (error?.code === 'ENOENT') return { version: 1 }
    throw new Error('豆包签到状态文件损坏，已暂停自动领取')
  }
}
async function saveState(value: State): Promise<void> {
  const dir = pluginDataDir(), target = statePath(), temp = `${target}.${randomUUID()}.tmp`
  await mkdir(dir, { recursive: true, mode: 0o700 })
  try { await writeFile(temp, JSON.stringify(value), { mode: 0o600, flag: 'wx' }); await rename(temp, target) } finally { await unlink(temp).catch(() => {}) }
}
function isLoopback(req: IncomingMessage): boolean {
  if (!req.headers.origin) return true
  try { return ['localhost', '127.0.0.1', '[::1]', '::1'].includes(new URL(req.headers.origin).hostname) } catch { return false }
}
function json(res: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value)
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(body)
}

/** Mount independently from the vendored pack so its failure cannot break the other channels. */
export function installDoubaoWork(ctx: Context): void {
  ctx.inject(['credentials'], (scope) => {
    async function session(): Promise<DoubaoWorkSession> {
      const credential = await scope.credentials.resolve(ref)
      if (!credential) throw new Error('请先导入本机豆包工作登录态')
      let value: unknown
      try { value = JSON.parse(credential.value) } catch { throw new Error('豆包工作登录态无效，请重新导入') }
      const item = value as Partial<DoubaoWorkSession> | null
      if (!item || typeof item.cookieHeader !== 'string' || typeof item.deviceId !== 'string') throw new Error('豆包工作登录态无效，请重新导入')
      return { cookieHeader: item.cookieHeader, deviceId: item.deviceId }
    }
    const adapter = new DoubaoWorkAdapter(session)
    let running: Promise<RewardOutcome> | undefined
    let outcome: string | undefined
    let quota: DoubaoQuota | undefined
    let quotaError: string | undefined
    let quotaRefreshing: Promise<void> | undefined
    async function refreshQuota(): Promise<void> {
      if (quotaRefreshing) return quotaRefreshing
      quotaRefreshing = (async () => {
        try {
          quota = parseDoubaoQuota(await doubaoPost(await session(), '/alice/commerce/sale/subscription/overview/', { product_line: 'membership' }))
          quotaError = undefined
        } catch (error) {
          quotaError = error instanceof Error ? error.message : '读取豆包额度失败'
          throw error
        }
      })().finally(() => { quotaRefreshing = undefined })
      return quotaRefreshing
    }
    async function checkin(): Promise<RewardOutcome> {
      if (running) return running
      running = (async () => {
        const auth = await session(), today = day()
        const dir = pluginDataDir(), lock = join(dir, 'doubao-work-checkin.lock')
        await mkdir(dir, { recursive: true, mode: 0o700 })
        let handle
        try { handle = await open(lock, 'wx', 0o600) } catch (error: any) {
          if (error?.code !== 'EEXIST') throw error
          const info = await stat(lock).catch(() => undefined)
          if (info && Date.now() - info.mtimeMs > 10 * 60_000) {
            await unlink(lock).catch(() => {})
            try { handle = await open(lock, 'wx', 0o600) } catch { outcome = 'pending'; return 'pending' }
          } else { outcome = 'pending'; return 'pending' }
        }
        try {
        // The cookie itself is never written to the check-in state file.
        const account = createHash('sha256').update(auth.deviceId).digest('hex').slice(0, 16)
        const getState = async () => { const saved = await loadState(); return saved.account === account || saved.account === undefined ? saved : { version: 1 as const } }
        const ledger = {
          pending: async () => (await getState()).pendingDay === today,
          markPending: async () => { if (day() !== today) throw new Error('签到日期已变化'); await saveState({ ...(await getState()), account, pendingDay: today }) },
          clearPending: async () => { const state = await getState(); delete state.pendingDay; state.checkedDay = today; state.account = account; await saveState(state) },
        }
        const result = await checkInDoubaoWork((path, body) => doubaoPost(auth, path, body), ledger)
        outcome = result
        return result
        } finally { await handle.close(); await unlink(lock).catch(() => {}) }
      })().finally(() => { running = undefined })
      return running
    }
    scope.effect(() => {
      const dispose = scope.llm.registerAdapter([DOUBAO_WORK_PROVIDER], adapter)
      return () => { dispose() }
    })
    scope.inject(['webServer'], (web) => {
      web.effect(() => web.webServer.register({ kind: 'exact', path: DOUBAO_WORK_PATH, handler: async (req, res) => {
        if (!isLoopback(req)) return json(res, 403, { error: 'origin-not-trusted' })
        if (req.method === 'GET') {
          const configured = (await scope.credentials.describe(ref)).configured
          return json(res, 200, { configured, running: running !== undefined, outcome: outcome ?? null,
            quota: quota ?? null, quotaError: quotaError ?? null, quotaRefreshing: quotaRefreshing !== undefined })
        }
        if (req.method !== 'POST' || !req.headers['content-type']?.startsWith('application/json')) return json(res, 405, { error: 'method not allowed' })
        const action = new URL(req.url ?? '/', 'http://localhost').searchParams.get('action')
        try {
          if (action === 'import') {
            const auth = await importLocalDoubaoWorkSession()
            await doubaoPost(auth, '/alice/user/launch', {})
            await scope.credentials.set(ref, JSON.stringify(auth))
            return json(res, 200, { configured: true })
          }
          if (action === 'checkin') return json(res, 200, { outcome: await checkin() })
          if (action === 'balance') { await refreshQuota(); return json(res, 200, { quota }) }
          return json(res, 400, { error: 'unknown action' })
        } catch (error) { return json(res, 400, { error: error instanceof Error ? error.message : '豆包工作操作失败' }) }
      } }))
    })
  })
}
