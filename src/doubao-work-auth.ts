/** Read the signed-in macOS desktop session only when the user imports it. */
import { createDecipheriv, createHash, pbkdf2Sync } from 'node:crypto'
import { execFile } from 'node:child_process'
import { readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { promisify } from 'node:util'

const runFile = promisify(execFile)
const DOMAINS = new Set(['.doubao.com', 'doubao.com', 'www.doubao.com'])

export interface DoubaoWorkSession {
  cookieHeader: string
  deviceId: string
}

/** Decrypt a single Chromium v10 cookie; version 24+ binds it to its host. */
export function decryptDoubaoCookie(encrypted: Uint8Array, host: string, key: Uint8Array, hostBound: boolean): string | undefined {
  const bytes = Buffer.from(encrypted)
  if (bytes.subarray(0, 3).toString('ascii') !== 'v10' || !DOMAINS.has(host)) return undefined
  try {
    const decipher = createDecipheriv('aes-128-cbc', key, Buffer.alloc(16, 0x20))
    let plaintext = Buffer.concat([decipher.update(bytes.subarray(3)), decipher.final()])
    if (hostBound) {
      const expected = createHash('sha256').update(host).digest()
      if (plaintext.length < expected.length || !plaintext.subarray(0, expected.length).equals(expected)) return undefined
      plaintext = plaintext.subarray(expected.length)
    }
    const value = plaintext.toString('utf8')
    return value === '' || /[\r\n;]/u.test(value) ? undefined : value
  } catch {
    return undefined
  }
}

/**
 * This deliberately does not persist or log the returned session. The caller
 * must store it in the host credential service and never expose it to the UI.
 */
export async function importLocalDoubaoWorkSession(): Promise<DoubaoWorkSession> {
  if (process.platform !== 'darwin') throw new Error('豆包工作本机登录导入目前仅支持 macOS')
  const root = join(homedir(), 'Library', 'Application Support', 'DoubaoWork')
  const statePath = join(root, 'Local State')
  if ((await stat(statePath)).size > 8 * 1024 * 1024) throw new Error('豆包工作本机配置文件过大')
  const state = JSON.parse(await readFile(statePath, 'utf8')) as { aha?: { device?: { device_id?: unknown } } }
  const rawDevice = state.aha?.device?.device_id
  const deviceId = typeof rawDevice === 'string' ? rawDevice : Number.isSafeInteger(rawDevice) ? String(rawDevice) : ''
  if (!/^[A-Za-z0-9_-]{1,64}$/u.test(deviceId)) throw new Error('豆包工作本机设备信息不可用')
  let password: string
  try {
    const result = await runFile('/usr/bin/security', ['find-generic-password', '-s', 'DoubaoWork Browser Safe Storage', '-w'], { timeout: 120_000, maxBuffer: 4096 })
    password = result.stdout.trimEnd()
  } catch {
    throw new Error('无法读取豆包工作钥匙串；请在系统提示中允许访问')
  }
  const key = pbkdf2Sync(password, 'saltysalt', 1003, 16, 'sha1')
  const db = new DatabaseSync(join(root, 'Default', 'Cookies'), { readOnly: true })
  try {
    const version = db.prepare("SELECT value FROM meta WHERE key = 'version'").get() as { value?: unknown } | undefined
    const hostBound = Number(version?.value ?? 0) >= 24
    const statement = db.prepare("SELECT host_key, name, path, encrypted_value, expires_utc FROM cookies WHERE host_key IN ('.doubao.com', 'doubao.com', 'www.doubao.com') AND path = '/' ORDER BY host_key")
    statement.setReadBigInts(true)
    const rows = statement.all() as Array<{ host_key: string; name: string; encrypted_value: Uint8Array; expires_utc: bigint }>
    const nowMicros = BigInt(Date.now() + 11_644_473_600_000) * 1000n
    const cookies: string[] = []
    for (const row of rows) {
      const expires = BigInt(row.expires_utc)
      if (expires !== 0n && expires <= nowMicros) continue
      if (!/^[!#$%&'*+.^_`|~A-Za-z0-9-]+$/u.test(row.name)) continue
      const value = decryptDoubaoCookie(row.encrypted_value, row.host_key, key, hostBound)
      if (value !== undefined) cookies.push(`${row.name}=${value}`)
    }
    if (!cookies.some(cookie => cookie.startsWith('sessionid='))) throw new Error('未找到有效的豆包工作登录态，请先在客户端登录')
    return { cookieHeader: cookies.join('; '), deviceId }
  } finally {
    key.fill(0)
    db.close()
  }
}
