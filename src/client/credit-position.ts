/** A viewport-relative rectangle in CSS pixels. */
export interface CreditPanelRect {
  left: number
  top: number
  bottom: number
  width: number
}

/** Position a measured panel above its trigger, flipping and clamping at viewport edges. */
export function creditPanelPosition(
  anchor: CreditPanelRect,
  panel: { width: number; height: number },
  viewport: { width: number; height: number; left?: number; top?: number },
): { left: number; top: number } {
  const margin = 8
  const minLeft = (viewport.left ?? 0) + margin
  const minTop = (viewport.top ?? 0) + margin
  const left = Math.min(
    Math.max(minLeft, anchor.left + anchor.width / 2 - panel.width / 2),
    Math.max(minLeft, (viewport.left ?? 0) + viewport.width - panel.width - margin),
  )
  const above = anchor.top - panel.height - margin
  const below = anchor.bottom + margin
  const preferAbove = above >= minTop || anchor.top - (viewport.top ?? 0) >= (viewport.top ?? 0) + viewport.height - anchor.bottom
  const top = Math.min(
    Math.max(minTop, preferAbove ? above : below),
    Math.max(minTop, (viewport.top ?? 0) + viewport.height - panel.height - margin),
  )
  return { top, left }
}
