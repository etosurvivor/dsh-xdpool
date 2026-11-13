import { useCallback, useEffect, useState } from 'react'
import { BrandTile } from './brand-tile.tsx'
import { DOUBAO_WORK_ICON } from './doubao-work-icon.ts'
import type { DoubaoQuota, DoubaoQuotaWindow } from '../doubao-work-quota.ts'

const PATH = '/api/xdpool/doubao-work'
type Status = { configured: boolean; running: boolean; outcome: string | null; quota: DoubaoQuota | null; quotaError: string | null; quotaRefreshing: boolean }
const labels: Record<string, string> = {
  claimed: '今日领取成功', 'already-claimed': '今日已领取', pending: '领取结果待确认，暂不重复提交',
  inactive: '当前没有签到活动', 'not-ready': '今日暂未满足领取条件',
}
export function DoubaoWorkCard() {
  const [status, setStatus] = useState<Status>()
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const refresh = useCallback(async () => {
    const response = await fetch(PATH, { credentials: 'same-origin' })
    if (!response.ok) throw new Error('豆包工作服务暂不可用')
    setStatus(await response.json() as Status)
  }, [])
  useEffect(() => { void refresh().catch(() => {}); const id = window.setInterval(() => { void refresh().catch(() => {}) }, 30_000); return () => window.clearInterval(id) }, [refresh])
  const action = async (name: 'import' | 'checkin' | 'balance') => {
    setBusy(true); setMessage('')
    try {
      const response = await fetch(`${PATH}?action=${name}`, { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: '{}' })
      const result = await response.json() as { error?: string; outcome?: string }
      if (!response.ok) throw new Error(result.error ?? '操作失败')
      setMessage(name === 'import' ? '登录态已导入' : name === 'balance' ? '额度已刷新' : labels[result.outcome ?? ''] ?? result.outcome ?? '')
      await refresh()
    } catch (error) { setMessage(error instanceof Error ? error.message : '操作失败') } finally { setBusy(false) }
  }
  return <article className="dsm-xdpool-cpool-card" data-state={status?.configured ? 'on' : 'idle'}
    style={{ '--dsm-xdpool-cpool-accent': '#7171e8' } as Record<string, string>}>
    <div className="dsm-xdpool-cpool-head">
      <BrandTile accent="#7171e8" glyph="chat" icon={DOUBAO_WORK_ICON} />
      <span className="dsm-xdpool-cpool-id"><b>豆包工作</b><span>字节跳动</span></span>
      <span className="dsm-xdpool-cpool-state" data-on={status?.configured === true}>
        {status?.configured ? '已连接' : '未连接'}
      </span>
    </div>
    <p className="dsm-xdpool-cpool-note">固定请求 DeepSeek V4.1 Flash；上游可能忽略模型选择，工具调用为实验性文本转换。</p>
    <div className="dsm-xdpool-cpool-meta"><span>账号 {status?.configured ? '1/1' : '0/0'}</span><span>模型 1/1</span>
      {status?.quota?.windows.map((item, index) => <span key={`${item.label}-${index}`} className="dsm-xdpool-cpool-credit">{quotaText(item)}</span>)}
      {status?.quota?.reward && <span className="dsm-xdpool-cpool-credit">{quotaText(status.quota.reward)}</span>}
      {status?.configured && !status.quota && <span>{status.quotaError ? '额度读取失败' : status.quotaRefreshing ? '额度读取中…' : '额度未刷新'}</span>}
    </div>
    <p className="dsm-xdpool-cpool-note">自动签到已暂停。</p>
    <div className="dsm-xdpool-cpool-acts">
      <button type="button" className="dsm-xdpool-btn" data-tone="primary" disabled={busy || !status?.configured || status.running} onClick={() => { void action('checkin') }}>手动检查并领取</button>
      <button type="button" className="dsm-xdpool-btn" data-tone="quiet" disabled={busy || !status?.configured || status.quotaRefreshing} onClick={() => { void action('balance') }}>刷新余额</button>
      <button type="button" className="dsm-xdpool-btn" data-tone="quiet" disabled={busy} onClick={() => { void action('import') }}>{status?.configured ? '重新导入登录' : '导入本机登录'}</button>
    </div>
    {message && <p className="dsm-xdpool-cpool-note" role="status">{message}</p>}
    {status?.outcome && labels[status.outcome] !== message && status.outcome !== message &&
      <p className="dsm-xdpool-cpool-note" role="status">{labels[status.outcome] ?? status.outcome}</p>}
  </article>
}

function quotaText(item: DoubaoQuotaWindow): string {
  if (item.unlimited) return `${item.label} 不限`
  if (item.remaining !== undefined) return `${item.label} ${item.remaining.toLocaleString('zh-CN', { maximumFractionDigits: 2 })}${item.total === undefined ? '' : ` / ${item.total.toLocaleString('zh-CN', { maximumFractionDigits: 2 })}`} 额度`
  if (item.remainingPercent !== undefined) return `${item.label}剩余 ${Math.round(item.remainingPercent)}%`
  return `${item.label} —`
}
