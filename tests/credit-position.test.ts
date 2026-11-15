import { describe, expect, it } from 'vitest'
import { creditPanelPosition } from '../src/client/credit-position.ts'

describe('credit panel viewport placement', () => {
  const panel = { width: 200, height: 120 }
  const viewport = { width: 600, height: 400 }

  it('opens directly above a bottom trigger', () => {
    expect(creditPanelPosition({ left: 300, top: 350, bottom: 370, width: 20 }, panel, viewport))
      .toEqual({ left: 210, top: 222 })
  })
  it('flips below when there is insufficient room above', () => {
    expect(creditPanelPosition({ left: 300, top: 20, bottom: 40, width: 20 }, panel, viewport))
      .toEqual({ left: 210, top: 48 })
  })
  it('clamps horizontal and vertical positions to viewport margins', () => {
    expect(creditPanelPosition({ left: 590, top: 395, bottom: 415, width: 20 }, panel, viewport))
      .toEqual({ left: 392, top: 267 })
    expect(creditPanelPosition({ left: 0, top: 2, bottom: 22, width: 20 }, panel, { width: 300, height: 100 }))
      .toEqual({ left: 8, top: 8 })
  })
  it('clamps within an offset visual viewport in layout coordinates', () => {
    const visible = { left: 200, top: 100, width: 400, height: 300 }
    expect(creditPanelPosition({ left: 570, top: 350, bottom: 370, width: 20 }, panel, visible))
      .toEqual({ left: 392, top: 222 })
    expect(creditPanelPosition({ left: 202, top: 110, bottom: 130, width: 20 }, panel, visible))
      .toEqual({ left: 208, top: 138 })
  })

})
