import { describe, expect, it } from 'vitest'
import { createChannelLane } from '../src/channel-lane.ts'

describe('channel model cache invalidation', () => {
  it('does not republish a stale list when an earlier request finishes late', async () => {
    let completeOld!: (rows: { id: string; name: string }[]) => void
    let calls = 0
    const published: string[][] = []
    const lane = createChannelLane({
      llm: { listModels: async () => ++calls === 1 ? await new Promise(resolve => { completeOld = resolve }) : [{ id: 'new', name: 'New' }], stream: async function* () {} },
      providers: () => ['doubao'], toId: (channel, model) => `${channel}:${model}`,
      onRows: rows => { published.push(rows.map(row => row.id)) },
    })
    const old = lane.rows()
    lane.invalidate('doubao')
    expect((await lane.rows()).map(row => row.id)).toEqual(['doubao:new'])
    completeOld([{ id: 'old', name: 'Old' }])
    expect((await old).map(row => row.id)).toEqual(['doubao:new'])
    expect(published.every(rows => rows.includes('doubao:new') && !rows.includes('doubao:old'))).toBe(true)
    expect((await lane.rows()).map(row => row.id)).toEqual(['doubao:new'])
  })
})
