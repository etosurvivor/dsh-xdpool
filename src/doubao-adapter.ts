import { randomUUID } from 'node:crypto'
import { LlmAdapter } from '@deepseek-ai/dsh-llm'
import { ReasoningEffortId, ToolCallId } from '@deepseek-ai/dsh-llm/brand'
import type { GenerateOptions, LlmModelInfo, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm/types'
import { DOUBAO_CONTEXT_WINDOW } from './doubao-catalog.ts'
import { decodeDoubaoToolResponse, doubaoPrompt } from './doubao-work-adapter.ts'
import { sessionUsable, type DoubaoSession } from './doubao-auth.ts'
import { createDoubaoLlm } from './doubao-llm.ts'
import { doubaoModelCatalog, type DoubaoModelStore } from './doubao-model-store.ts'
import type { LocalDoubaoModel } from './doubao-local-models.ts'

export const DOUBAO_PROVIDER_ID = 'heybash-doubao'
export const DIRECT_DOUBAO_MODELS = doubaoModelCatalog([]).filter(model => model.id === '0' || model.id === '3')
export interface DoubaoAdapterModels {
  ready: Promise<void>
  store: Pick<DoubaoModelStore, 'isEnabled'>
  catalog?: () => readonly LocalDoubaoModel[]
}
const effortId = (level: number): string => ({ 3: 'low', 4: 'mid', 5: 'high', 6: 'xhigh', 7: 'max' } as Record<number, string>)[level] ?? String(level)

export class DoubaoAdapter extends LlmAdapter {
  constructor(private readonly session: () => DoubaoSession | undefined, private readonly models?: DoubaoAdapterModels) { super() }
  override providerInfo() { return { id: DOUBAO_PROVIDER_ID, name: '豆包' } }
  private async allModels(): Promise<readonly LocalDoubaoModel[]> {
    if (this.models === undefined) return DIRECT_DOUBAO_MODELS
    await this.models.ready
    return this.models.catalog?.() ?? doubaoModelCatalog()
  }
  override async listModels(): Promise<LlmModelInfo[]> {
    if (!sessionUsable(this.session())) return []
    return (await this.allModels()).filter(model => this.models?.store.isEnabled(model.id) !== false).map(model => ({ provider: DOUBAO_PROVIDER_ID, id: model.id, name: model.name, ...(model.rate ? { description: model.rate } : {}), inputModalities: ['text'] }))
  }
  override async resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    if (!sessionUsable(this.session()) || provider !== DOUBAO_PROVIDER_ID) throw new Error('豆包模型不可用，请先登录')
    const item = (await this.allModels()).find(row => row.id === model)
    if (item === undefined) throw new Error('豆包模型不存在或未被客户端菜单识别')
    const efforts = item.reasoning?.map(option => ({ id: ReasoningEffortId(effortId(option.level)), name: option.name })) ?? []
    return { provider, id: item.id, name: item.name, ...(item.rate ? { description: item.rate } : {}), inputModalities: ['text'], context: { contextWindow: DOUBAO_CONTEXT_WINDOW }, ...(efforts.length ? { reasoning: { efforts } } : {}) }
  }
  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    try {
      if (options.provider !== DOUBAO_PROVIDER_ID) throw new Error('豆包模型不可用')
      const item = (await this.allModels()).find(model => model.id === options.model)
      if (item === undefined) throw new Error('豆包模型不存在或未被客户端菜单识别')
      const lane = createDoubaoLlm({ session: this.session })
      const hasTools = (options.tools?.length ?? 0) > 0 && item.id !== 'image-gen'
      const messages = hasTools ? [{ role: 'user', content: [{ type: 'text', text: doubaoPrompt(options) }] }] : options.messages
      let text = ''
      let reasoning = ''
      if (!hasTools) yield { type: 'block-start', index: 0, blockType: 'text' }
      for await (const chunk of lane.stream({ ...options, taskMode: item.mode === 'work', system: hasTools ? '' : options.system, messages })) {
        if (chunk.type === 'text-delta') {
          if (hasTools) text += chunk.text
          else { text += chunk.text; yield { type: 'text-delta', index: 0, text: chunk.text } }
        } else if (chunk.type === 'reasoning-delta' && !hasTools) reasoning += chunk.text
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
