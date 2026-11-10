/** Render the Heybash shell and verify its public header and existing tab action. */
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'

const ROOT = join(import.meta.dirname, '..')
const require_ = createRequire(join(ROOT, 'package.json'))
const TMP = join(ROOT, '.probe-shell')

// The component is TypeScript. Compile it with the repo's own tsc into a temp
// directory instead of re-implementing a transpiler: a probe that fakes the
// compiler can drift from what ships.
rmSync(TMP, { recursive: true, force: true })
mkdirSync(TMP, { recursive: true })
const built = spawnSync(process.execPath, [
  join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc'),
  join(ROOT, 'src', 'client', 'shell.tsx'),
  join(ROOT, 'src', 'client', 'avatar.ts'),
  '--ignoreConfig',
  '--outDir', TMP,
  '--rootDir', join(ROOT, 'src'),
  '--module', 'es2022',
  '--target', 'es2022',
  '--moduleResolution', 'bundler',
  '--jsx', 'react-jsx',
  '--allowImportingTsExtensions',
  '--rewriteRelativeImportExtensions',
  '--skipLibCheck',
], { encoding: 'utf8' })
if (built.status !== 0) {
  console.error(built.stdout)
  console.error(built.stderr)
  throw new Error('tsc could not compile shell.tsx')
}
// tsc emits with `.js` extensions relative to the source tree; rewrite them so
// the temp module graph resolves.
const emitted = readFileSync(join(TMP, 'client', 'shell.js'), 'utf8')
writeFileSync(join(TMP, 'client', 'shell.js'), emitted)

const { PoolShell } = await import(`file://${join(TMP, 'client', 'shell.js').replaceAll('\\', '/')}`)
const { createElement: h } = require_('react')

/**
 * A hook harness good enough for `PoolShell`.
 *
 * State lives in a plain slot array keyed by call order, which is exactly React's
 * contract for a component that never branches around a hook. `setState` marks
 * the tree dirty and schedules ONE re-render, the way React batches.
 */
function createHarness() {
  const slots = []
  let index = 0
  let dirty = false
  const harness = {
    reset() { index = 0 },
    take(init) {
      const at = index++
      if (at >= slots.length) slots[at] = init()
      return [slots[at], next => { slots[at] = typeof next === 'function' ? next(slots[at]) : next; dirty = true }]
    },
    useState(init) { return harness.take(() => (typeof init === 'function' ? init() : init)) },
    useRef(init) { return harness.take(() => ({ current: init })) },
    useCallback(fn) { return harness.take(() => fn)[0] },
    useMemo(fn) { return harness.take(fn)[0] },
    useLayoutEffect() { index += 1 },
    useEffect() { index += 1 },
    useId() { return harness.take(() => `probe-${String(index + 1)}`)[0] },
    get dirty() { return dirty },
    clear() { dirty = false },
  }
  return harness
}

const harness = createHarness()
// Point React's internal dispatcher at the harness. `react` exports
// `__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED` for exactly this kind of
// host integration, and it is the documented hook into the hook dispatcher.
const internals = require_('react').__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED
const dispatcher = internals.ReactCurrentDispatcher
if (dispatcher === undefined) throw new Error('React has no current dispatcher; cannot drive hooks')

const { POOL_CARD_AVATAR } = await import(`file://${join(TMP, 'client', 'avatar.js')}`)
let selectedTab
const base = {
  tabs: [{ id: 'pool', label: 'Account pool' }, { id: 'channels', label: 'Login channels' }],
  active: 'pool',
  avatar: POOL_CARD_AVATAR,
  onSelect: id => { selectedTab = id },
  version: '9.9.9',
  children: h('div', null, 'body'),
}

function render() {
  harness.reset()
  const previous = dispatcher.current
  dispatcher.current = {
    useState: harness.useState,
    useRef: harness.useRef,
    useCallback: harness.useCallback,
    useMemo: harness.useMemo,
    useLayoutEffect: harness.useLayoutEffect,
    useEffect: harness.useEffect,
    useId: harness.useId,
    useContext: () => undefined,
    useDebugValue: () => undefined,
  }
  try {
    return PoolShell(base)
  } finally {
    dispatcher.current = previous
  }
}

/** Every element in a rendered tree. */
function walk(node, out = []) {
  if (Array.isArray(node)) { for (const child of node) walk(child, out); return out }
  if (node === null || typeof node !== 'object') return out
  if (node.props !== undefined) out.push(node)
  const props = node.props ?? {}
  for (const value of Object.values(props)) {
    if (Array.isArray(value)) walk(value, out)
    else if (typeof value === 'object' && value !== null && value.props !== undefined) walk(value, out)
  }
  return out
}

const classOf = element => String(element.props?.className ?? '')

const all = walk(render())
const project = all.find(el => el.type === 'a' && classOf(el).includes('dsm-xdpool-project'))
if (project?.props.href !== 'https://github.com/etosurvivor/dsh-xdpool') {
  throw new Error('the project link must open the Heybash fork')
}
if (all.some(el => classOf(el).includes('dsm-xdpool-group') || el.props.role === 'dialog')) {
  throw new Error('a removed community control is still rendered')
}
const tab = all.find(el => el.props?.role === 'tab')
if (typeof tab?.props.onClick !== 'function') throw new Error('the shell tabs are not interactive')
tab.props.onClick()
if (selectedTab !== 'pool') throw new Error('the selected tab was not delivered to the parent')
const logo = all.find(el => el.type === 'img' && classOf(el).includes('dsm-xdpool-avatar'))
const officialLogo = 'data:image/png;base64,' + readFileSync(join(ROOT, 'assets', 'heybash-logo.png')).toString('base64')
if (logo?.props.src !== officialLogo) throw new Error('the header does not render the official Heybash logo')
console.log('Heybash project link present; community controls absent; tabs interactive')
rmSync(TMP, { recursive: true, force: true })
console.log('OK')
