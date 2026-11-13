import { randomUUID } from 'node:crypto'
import type { DoubaoWorkSession } from './doubao-work-auth.ts'

/** Requested model: upstream selection is not independently verifiable. */
export const DOUBAO_WORK_MODEL = 'person-deepseek-v4-1-flash-261017'
const ORIGIN = 'https://www.doubao.com'

export function doubaoRequestUrl(session: DoubaoWorkSession, path: string): string {
  if (!path.startsWith('/alice/') && path !== '/chat/completion') throw new Error('Unsupported Doubao endpoint')
  const url = new URL(path, ORIGIN)
  const params: Record<string, string> = { aid: '1044603', real_aid: '1044603', device_platform: 'web', version_code: '20800', samantha_web: '1', web_platform: 'desktop', doubao_device_platform: 'desktop', client_platform: 'pc_client', pkg_type: 'release_version', runtime: 'web', runtime_version: '3.42.2', pc_version: '2.36.15', doubao_pc_version: '2.36.15', 'use-olympus-account': '1', language: 'zh', region: 'CN', sys_region: 'CN', device_id: session.deviceId }
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value)
  return url.toString()
}

export function doubaoHeaders(session: DoubaoWorkSession): Record<string, string> {
  if (!session.cookieHeader || /[\r\n]/u.test(session.cookieHeader)) throw new Error('豆包登录态无效，请重新导入')
  return { cookie: session.cookieHeader, origin: ORIGIN, referer: `${ORIGIN}/chat/`, 'content-type': 'application/json', 'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36' }
}

export async function doubaoPost(session: DoubaoWorkSession, path: string, body: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
  const response = await fetch(doubaoRequestUrl(session, path), { method: 'POST', headers: doubaoHeaders(session), body: JSON.stringify(body), signal: signal ?? AbortSignal.timeout(30_000) })
  if (!response.ok) throw new Error(`豆包工作请求失败 HTTP ${response.status}`)
  const value = await response.json() as { code?: unknown }
  if (value.code !== 0 && value.code !== '0') throw new Error('豆包工作请求失败，请检查登录状态或活动是否有效')
  return value
}

export function doubaoChatBody(prompt: string, botId: string, modelExtra: Record<string, unknown> = {}): Record<string, unknown> {
  const now = Date.now(), localId = randomUUID()
  return {
    client_meta: { local_conversation_id: `local_${now}${Math.floor(Math.random() * 1000)}`, conversation_id: '', bot_id: botId, last_section_id: '', last_message_index: null },
    messages: [{ local_message_id: localId, content_block: [{ block_type: 10000, content: { text_block: { text: prompt, icon_url: '', icon_url_dark: '', summary: '' }, pc_event_block: '' }, block_id: randomUUID(), parent_id: '', meta_info: [], append_fields: [] }], message_status: 0 }],
    option: { create_time_ms: now, need_create_conversation: true, conversation_init_option: { need_ack_conversation: true }, conversation_init_ext: { model_item_key: DOUBAO_WORK_MODEL, mode_id: '1' }, need_deep_think: 0, is_audio: false, answer_with_suggest: false, tts_switch: false, is_regen: false, is_replace: false, unique_key: randomUUID(), start_seq: 0, sse_recv_event_options: { support_chunk_delta: true }, recovery_option: { is_recovery: false, req_create_time_sec: Math.floor(now / 1000), append_sse_event_scene: 0 }, message_storage_type: 0, agent_mode: 2, model_config: { model_item_key: DOUBAO_WORK_MODEL, model_extra_params: modelExtra }, aggregate_params: { mode_id: '1', model_item_key: DOUBAO_WORK_MODEL, agent_mode: '2' } },
    user_context: [], ext: { use_deep_think: '0', sub_conv_firstmet_type: '1', commerce_credit_config_enable: '0', agent_mode: '2' },
  }
}

/** Extract assistant text only. User echo frames must never become an answer. */
export function parseDoubaoSse(raw: string): string {
  const blocks = new Map<string, string>()
  let ended = false
  const add = (items: unknown, append: boolean): void => {
    if (!Array.isArray(items)) return
    for (const item of items) {
      if (Number(item?.block_type) !== 10000 || typeof item?.content?.text_block?.text !== 'string') continue
      const id = String(item.block_id ?? 'default'), text = item.content.text_block.text, old = blocks.get(id) ?? ''
      blocks.set(id, append ? old + text : text.startsWith(old) ? text : old || text)
    }
  }
  for (const frame of raw.split(/\r?\n\r?\n/u)) {
    const lines = frame.split(/\r?\n/u), event = lines.find(line => line.startsWith('event:'))?.slice(6).trim() ?? ''
    const data = lines.filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n')
    if (!data) continue
    let value: any
    try { value = JSON.parse(data) } catch { throw new Error('豆包工作返回了无效的流数据') }
    if (event.includes('ERR') || event === 'error' || value.error_code || value.error) {
      if (Number(value.error_code) === 710022004) throw new Error('豆包工作触发请求限制或验证，请稍后在豆包工作客户端检查账号状态')
      const code = typeof value.error_code === 'number' ? ` (${value.error_code})` : ''
      throw new Error(`豆包工作请求失败${code}，请检查登录状态`)
    }
    if (event === 'FULL_MSG_NOTIFY' && Number(value.message?.user_type) === 2) add(value.message.content_block, false)
    if (event === 'STREAM_MSG_NOTIFY' && Number(value.meta?.user_type) === 2) add(value.content?.content_block, true)
    if (event === 'CHUNK_DELTA' && typeof value.text === 'string') add([{ block_id: 'delta', block_type: 10000, content: { text_block: { text: value.text } } }], true)
    if (event === 'STREAM_CHUNK') for (const operation of value.patch_op ?? []) if (Number(operation.patch_object) === 1) add(operation.patch_value?.content_block, Number(operation.patch_type) === 1)
    if (event === 'SSE_REPLY_END') ended = true
  }
  const text = [...blocks.values()].join('')
  if (!ended || !text) throw new Error('豆包工作响应不完整或没有返回文本')
  return text
}

export async function requestDoubaoText(session: DoubaoWorkSession, prompt: string, signal?: AbortSignal): Promise<string> {
  const launch = await doubaoPost(session, '/alice/user/launch', {}, signal) as { data?: { assistant_bot_id?: unknown } }
  const bot = launch.data?.assistant_bot_id
  if (typeof bot !== 'string' && typeof bot !== 'number') throw new Error('豆包工作登录状态不可用，请重新导入')
  const response = await fetch(doubaoRequestUrl(session, '/chat/completion'), {
    method: 'POST', headers: { ...doubaoHeaders(session), accept: 'text/event-stream' },
    body: JSON.stringify(doubaoChatBody(prompt, String(bot))), signal: signal ?? AbortSignal.timeout(120_000),
  })
  if (!response.ok || !response.body) throw new Error(`豆包工作对话请求失败 HTTP ${response.status}`)
  const reader = response.body.getReader(), decoder = new TextDecoder(), chunks: string[] = []
  let total = 0
  try {
    for (;;) {
      const next = await reader.read()
      if (next.done) break
      total += next.value.byteLength
      if (total > 8 * 1024 * 1024) throw new Error('豆包工作响应过大')
      chunks.push(decoder.decode(next.value, { stream: true }))
    }
    chunks.push(decoder.decode())
  } finally { reader.releaseLock() }
  return parseDoubaoSse(chunks.join(''))
}
