import { randomUUID } from 'node:crypto'
import { LlmAdapter } from '@deepseek-ai/dsh-llm'
import { ToolCallId } from '@deepseek-ai/dsh-llm/brand'
import type { GenerateOptions, LlmModelInfo, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm/types'
import { DOUBAO_CONTEXT_WINDOW, DOUBAO_MODELS } from './doubao-catalog.ts'
import { decodeDoubaoToolResponse, doubaoPrompt } from './doubao-work-adapter.ts'
import { sessionUsable, type DoubaoSession } from './doubao-auth.ts'
import { createDoubaoLlm } from './doubao-llm.ts'

export const DOUBAO_PROVIDER_ID = 'heybash-doubao'
// The user chose direct conversation, without relaying through cloud work tasks.
export const DIRECT_DOUBAO_MODELS = DOUBAO_MODELS.filter(model => model.id === '0' || model.id === '3')

export class DoubaoAdapter extends LlmAdapter {
  private readonly session: () => DoubaoSession | undefined
  constructor(session: () => DoubaoSession | undefined) { super(); this.session = session }
  override providerInfo() { return { id: DOUBAO_PROVIDER_ID, name: '豆包' } }
  override async listModels(): Promise<LlmModelInfo[]> {
    if (!sessionUsable(this.session())) return []
    return DIRECT_DOUBAO_MODELS.map(model => ({ provider: DOUBAO_PROVIDER_ID, id: model.id, name: model.name, inputModalities: ['text'] }))
  }
  override async resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    const row = (await this.listModels()).find(item => item.id === model)
    if (provider !== DOUBAO_PROVIDER_ID || row === undefined) throw new Error('豆包模型不可用，请先登录')
    return { ...row, context: { contextWindow: DOUBAO_CONTEXT_WINDOW } }
  }
  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    try {
      if (options.provider !== DOUBAO_PROVIDER_ID || !DIRECT_DOUBAO_MODELS.some(model => model.id === options.model)) throw new Error('豆包模型不可用')
      const lane = createDoubaoLlm({ session: this.session })
      const hasTools = (options.tools?.length ?? 0) > 0
      const messages = hasTools
        ? [{ role: 'user', content: [{ type: 'text', text: doubaoPrompt(options) }] }]
        : options.messages
      let text = ''
      let reasoning = ''
      if (!hasTools) yield { type: 'block-start', index: 0, blockType: 'text' }
      for await (const chunk of lane.stream({ ...options, system: hasTools ? '' : options.system, messages })) {
        if (chunk.type === 'text-delta') {
          if (hasTools) text += chunk.text
          else { text += chunk.text; yield { type: 'text-delta', index: 0, text: chunk.text } }
        } else if (chunk.type === 'reasoning-delta' && !hasTools) {
          reasoning += chunk.text
        }
      }
      if (!hasTools) {
        yield { type: 'block-end', index: 0, block: { type: 'text', text } }
        if (reasoning !== '') {
          yield { type: 'block-start', index: 1, blockType: 'reasoning' }
          yield { type: 'reasoning-delta', index: 1, text: reasoning }
          yield { type: 'block-end', index: 1, block: { type: 'reasoning', text: reasoning } }
        }
      }
      if (hasTools) {
        const output = decodeDoubaoToolResponse(text, options.tools)
        if (output.calls) {
          for (const [index, call] of output.calls.entries()) {
            const id = ToolCallId(`call_${randomUUID()}`)
            yield { type: 'block-start', index, blockType: 'tool-call' }
            yield { type: 'tool-call-delta', index, id, name: call.name, argumentsDelta: call.arguments }
            yield { type: 'block-end', index, block: { type: 'tool-call', id, name: call.name, arguments: call.arguments } }
          }
          yield { type: 'finish', reason: { kind: 'tool-calls' } }
          return
        }
        const answer = output.answer ?? ''
        yield { type: 'block-start', index: 0, blockType: 'text' }
        yield { type: 'text-delta', index: 0, text: answer }
        yield { type: 'block-end', index: 0, block: { type: 'text', text: answer } }
      }
      yield { type: 'finish', reason: { kind: 'stop' } }
    } catch (error: unknown) {
      yield { type: 'finish', reason: { kind: options.signal?.aborted ? 'aborted' : 'error', failure: { code: 'DOUBAO_ERROR', message: error instanceof Error ? error.message : '豆包请求失败' } } }
    }
  }
}
