import { ComboRouteState } from '../../src/combo-route-state.ts'
const [path, mode, key] = process.argv.slice(2)
const state = new ComboRouteState(path)
if (mode === 'hold') {
  await state.lockSession(key, new AbortController().signal)
  process.send?.('locked')
  setInterval(() => {}, 1000)
} else if (mode === 'bind') {
  const release = await state.lockSession(key, new AbortController().signal)
  state.transaction(() => state.setBinding(key, 'member', 'account'))
  release()
  state.close()
  process.send?.('done')
} else throw new Error('unknown mode')
