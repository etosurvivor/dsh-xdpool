import { afterEach, expect, it } from 'vitest'
import { fork, type ChildProcess } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ComboRouteState } from '../src/combo-route-state.ts'

const children = new Set<ChildProcess>()
afterEach(() => { for (const child of children) child.kill(); children.clear() })
function start(path: string, mode: string, key: string): ChildProcess {
  const child = fork(fileURLToPath(new URL('./fixtures/combo-state-process.mjs', import.meta.url)), [path, mode, key], { execArgv: ['--experimental-strip-types', '--no-warnings'], silent: true })
  children.add(child)
  child.once('exit', () => children.delete(child))
  return child
}
function message(child: ChildProcess): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let errors = ''
    child.stderr?.on('data', chunk => { errors += String(chunk) })
    child.once('message', resolve)
    child.once('error', reject)
    child.once('exit', code => { if (code !== 0) reject(new Error(`worker exited ${code}: ${errors}`)) })
  })
}

it('serializes the same session across actual processes and recovers after an owner dies', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'xdpool-process-'))
  try {
    const path = join(dir, 'state.json')
    const owner = start(path, 'hold', 'session')
    expect(await message(owner)).toBe('locked')
    const waiting = start(path, 'bind', 'session')
    const finished = message(waiting)
    expect(await Promise.race([finished.then(() => 'finished'), new Promise(resolve => setTimeout(() => resolve('waiting'), 200))])).toBe('waiting')
    const exited = new Promise(resolve => owner.once('exit', resolve))
    owner.kill('SIGKILL')
    await exited
    expect(await finished).toBe('done')
    const state = new ComboRouteState(path)
    expect(state.binding('session')).toEqual({ member: 'member', accountId: 'account', confirmed: true })
    state.close()
  } finally { await rm(dir, { recursive: true, force: true }) }
})

it('retains simultaneous writes from multiple independent processes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'xdpool-process-writes-'))
  try {
    const path = join(dir, 'state.json')
    const workers = Array.from({ length: 8 }, (_, i) => start(path, 'bind', `session-${i}`))
    expect(await Promise.all(workers.map(message))).toEqual(Array(8).fill('done'))
    const state = new ComboRouteState(path)
    for (let i = 0; i < 8; i += 1) expect(state.binding(`session-${i}`)?.accountId).toBe('account')
    state.close()
  } finally { await rm(dir, { recursive: true, force: true }) }
})

it('balances and preserves session bindings across separate running shim processes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'xdpool-process-shims-'))
  try {
    const path = join(dir, 'state.json')
    const fixture = fileURLToPath(new URL('./fixtures/combo-shim-process.mjs', import.meta.url))
    const workers = [0, 1].map(() => {
      const child = fork(fixture, [path], { execArgv: ['--experimental-transform-types', '--no-warnings'], silent: true })
      children.add(child)
      child.once('exit', () => children.delete(child))
      return child
    })
    const endpoints = await Promise.all(workers.map(message)) as { base: string; token: string }[]
    const ask = async (index: number, session: string): Promise<string> => {
      const endpoint = endpoints[index]!
      const r = await fetch(`${endpoint.base}/v1/chat/completions`, { method: 'POST', headers: { authorization: `Bearer ${endpoint.token}`, 'content-type': 'application/json', 'x-session-id': session }, body: JSON.stringify({ model: 'combo:shared', stream: false, messages: [{ role: 'user', content: 'hi' }] }) })
      expect(r.status).toBe(200)
      const body = await r.json() as { choices: { message: { content: string } }[] }
      return body.choices[0]!.message.content
    }
    const first = await Promise.all([ask(0, 'session-a'), ask(1, 'session-b')])
    expect(new Set(first).size).toBe(2)
    expect(await ask(1, 'session-a')).toBe(first[0])
    expect(await ask(0, 'session-b')).toBe(first[1])
    const same = await Promise.all([ask(0, 'same'), ask(1, 'same')])
    expect(same[0]).toBe(same[1])
    await Promise.all(workers.map(child => new Promise<void>(resolve => { child.once('exit', () => resolve()); child.send('stop') })))
  } finally { await rm(dir, { recursive: true, force: true }) }
})
