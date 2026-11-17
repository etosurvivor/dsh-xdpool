import { AggregateCatalog } from '../../src/aggregate.ts'
import { createChannelLane } from '../../src/channel-lane.ts'
import { createWorkBuddyShim } from '../../src/shim.ts'
const path = process.argv[2]
const llm = {
  listModels: async () => [{ id: 'x' }],
  stream: options => (async function* () {
    yield { type: 'text-delta', index: 0, text: String(options.provider) }
    yield { type: 'finish', reason: { kind: 'stop' } }
  })(),
}
const channels = createChannelLane({ llm, providers: () => ['trae', 'loomy'], toId: (p, m) => `${p}:${m}` })
const hosts = await channels.rows()
const store = { version: 1, combos: [{ name: 'shared', models: ['trae:x', 'loomy:x'], strategy: 'round-robin' }] }
const catalog = new AggregateCatalog(() => store, () => [], () => hosts)
await catalog.refresh()
const shim = createWorkBuddyShim({ pool: { list: () => [], acquire: async () => undefined }, client: {}, catalog: { current: () => [], find: () => undefined }, aggregate: { catalog, readStore: () => store }, channels, comboAffinityPath: path })
await shim.ready
process.send?.({ base: shim.baseUrl(), token: shim.token() })
process.on('message', async () => { await shim.close(); process.disconnect() })
