export type ResizeEdge = 'n' | 'e' | 's' | 'w'

export type ResizeCorner = 'nw' | 'ne' | 'sw' | 'se'

export type ResizeHandle = ResizeEdge | ResizeCorner

const CORNERS = new Set<string>(['nw', 'ne', 'sw', 'se'])

export function isResizeCorner(h: ResizeHandle): h is ResizeCorner {
  return CORNERS.has(h)
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n))
}

function clampRect(
  x: number,
  y: number,
  w: number,
  h: number,
  b: ResizeBounds,
): { x: number; y: number; w: number; h: number } {
  w = clamp(w, b.minW, b.maxW)
  h = clamp(h, b.minH, b.maxH)
  x = clamp(x, 0, b.spanX - w)
  y = clamp(y, 0, b.spanY - h)
  w = Math.min(w, b.spanX - x)
  h = Math.min(h, b.spanY - y)
  return { x, y, w, h }
}

export type RectStart = {
  x: number
  y: number
  w: number
  h: number
  clientX: number
  clientY: number
}

export type ResizeBounds = {
  minW: number
  maxW: number
  minH: number
  maxH: number
  /** max value for x + w (e.g. board width) */
  spanX: number
  /** max value for y + h (e.g. board height) */
  spanY: number
}

/** Compute new rect after dragging an edge from `start` to `clientX/clientY`. */
export function applyEdgeResize(
  edge: ResizeEdge,
  start: RectStart,
  clientX: number,
  clientY: number,
  b: ResizeBounds,
): { x: number; y: number; w: number; h: number } {
  const dx = clientX - start.clientX
  const dy = clientY - start.clientY

  switch (edge) {
    case 'e': {
      const w = clamp(
        start.w + dx,
        b.minW,
        Math.min(b.maxW, b.spanX - start.x),
      )
      return { x: start.x, y: start.y, w, h: start.h }
    }
    case 's': {
      const h = clamp(
        start.h + dy,
        b.minH,
        Math.min(b.maxH, b.spanY - start.y),
      )
      return { x: start.x, y: start.y, w: start.w, h }
    }
    case 'w': {
      let w = clamp(start.w - dx, b.minW, b.maxW)
      let x = start.x + start.w - w
      x = clamp(x, 0, b.spanX - w)
      w = Math.min(w, b.spanX - x)
      return { x, y: start.y, w, h: start.h }
    }
    case 'n': {
      let h = clamp(start.h - dy, b.minH, b.maxH)
      let y = start.y + start.h - h
      y = clamp(y, 0, b.spanY - h)
      h = Math.min(h, b.spanY - y)
      return { x: start.x, y, w: start.w, h }
    }
    default:
      return { x: start.x, y: start.y, w: start.w, h: start.h }
  }
}

/** Resize by dragging a corner (opposite corner is the anchor). */
export function applyCornerResize(
  corner: ResizeCorner,
  start: RectStart,
  clientX: number,
  clientY: number,
  b: ResizeBounds,
): { x: number; y: number; w: number; h: number } {
  const dx = clientX - start.clientX
  const dy = clientY - start.clientY

  switch (corner) {
    case 'se': {
      const w = start.w + dx
      const h = start.h + dy
      return clampRect(start.x, start.y, w, h, b)
    }
    case 'nw': {
      const w = start.w - dx
      const h = start.h - dy
      const x = start.x + start.w - w
      const y = start.y + start.h - h
      return clampRect(x, y, w, h, b)
    }
    case 'ne': {
      const w = start.w + dx
      const h = start.h - dy
      const y = start.y + start.h - h
      return clampRect(start.x, y, w, h, b)
    }
    case 'sw': {
      const w = start.w - dx
      const h = start.h + dy
      const x = start.x + start.w - w
      return clampRect(x, start.y, w, h, b)
    }
    default:
      return { x: start.x, y: start.y, w: start.w, h: start.h }
  }
}
