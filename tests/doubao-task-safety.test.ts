import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildChatBody, runToolLocalResponder } from '../src/doubao-upstream.ts'

afterEach(() => vi.unstubAllGlobals())
describe('豆包工作任务中的本地操作', () => {
  it('sends the selected model and effort in work mode without exposing local paths', () => {
    const body = buildChatBody('hello', { modelKey: 'person-deepseek-v4-1-flash-261017', taskMode: true, isolatedWorkspace: true, reasoningLevel: 'max' })
    expect(body.option.conversation_init_ext).toMatchObject({ model_item_key: 'person-deepseek-v4-1-flash-261017', mode_id: '3', reasoning_effort: '7' })
    expect(body.option.model_config.model_item_key).toBe('person-deepseek-v4-1-flash-261017')
    expect(body.option.aggregate_params).toMatchObject({ model_item_key: 'person-deepseek-v4-1-flash-261017', mode_id: '3' })
    const task = body.option.general_task_param as { client_option: { agent_workspace: { local_skill_paths: string[] } }; agent_task_param: { device_name: string } }
    expect(task.client_option.agent_workspace.local_skill_paths).toEqual([])
    expect(task.agent_task_param.device_name).toBe('DSH')
  })
  it('does not acknowledge or fabricate success for unexecuted commands', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ code: 0, data: { msgs: [{ body: { cmd_call: { cmd_id: 'c', input: JSON.stringify({ operations: [{ type: 'write', path: '/example' }] }) } } }] } }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const creds = { pairs: new Map([['sessionid', 's']]), header: 'sessionid=s', userAgent: 'test' }
    await expect(runToolLocalResponder('request', creds, () => false, AbortSignal.timeout(1000))).rejects.toThrow('本地操作')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('/msg/ack')
  })
})
