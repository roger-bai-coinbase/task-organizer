import { describe, expect, it } from 'vitest'
import { applyCornerResize, applyEdgeResize, type RectStart } from './resizeApply'

const start: RectStart = {
  x: 100,
  y: 80,
  w: 200,
  h: 120,
  clientX: 300,
  clientY: 200,
}

const bounds = {
  minW: 80,
  maxW: 360,
  minH: 60,
  maxH: 240,
  spanX: 500,
  spanY: 400,
}

describe('resizeApply', () => {
  it('resizes east and clamps to the available span', () => {
    expect(applyEdgeResize('e', start, 800, 200, bounds)).toEqual({
      x: 100,
      y: 80,
      w: 360,
      h: 120,
    })
  })

  it('resizes west while anchoring the right edge', () => {
    expect(applyEdgeResize('w', start, 360, 200, bounds)).toEqual({
      x: 160,
      y: 80,
      w: 140,
      h: 120,
    })
  })

  it('resizes northwest and keeps the rect inside bounds', () => {
    expect(applyCornerResize('nw', start, -100, -100, bounds)).toEqual({
      x: 0,
      y: 0,
      w: 360,
      h: 240,
    })
  })
})
