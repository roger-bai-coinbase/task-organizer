import type { BoardState, ProjectNote } from './types'

/** Circular distance between two hues in [0, 180]. */
export function hueDistance(a: number, b: number): number {
  const x = Math.abs(((a % 360) + 360) % 360 - ((b % 360) + 360) % 360) % 360
  return Math.min(x, 360 - x)
}

/** Stable hue 0–359 from an id (older boards without stored `hue`). */
export function hueFromId(id: string): number {
  let h = 2166136261
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return (h >>> 0) % 360
}

function hashUint(id: string): number {
  let x = 0
  for (let i = 0; i < id.length; i++) {
    x = (x * 31 + id.charCodeAt(i)) >>> 0
  }
  return x
}

/** Pick a hue maximally separated from existing ones (post-it “very different”). */
export function pickDistinctHue(existing: number[]): number {
  if (existing.length === 0) return 48
  let best = 0
  let bestMin = -1
  for (let cand = 0; cand < 360; cand += 2) {
    const m = Math.min(...existing.map((e) => hueDistance(cand, e)))
    if (m > bestMin) {
      bestMin = m
      best = cand
    }
  }
  return best
}

export type ProjectPalette = {
  gradient: string
  ink: string
  headerBorder: string
}

export function projectPalette(hue: number): ProjectPalette {
  const h = ((hue % 360) + 360) % 360
  const light = `hsl(${h} 78% 82%)`
  const mid = `hsl(${h} 72% 74%)`
  const deep = `hsl(${h} 68% 64%)`
  return {
    gradient: `linear-gradient(148deg, ${light} 0%, ${mid} 45%, ${deep} 100%)`,
    ink: `hsl(${h} 22% 14%)`,
    headerBorder: `hsla(${h}, 35%, 22%, 0.14)`,
  }
}

export type MiniPalette = {
  gradient: string
  ink: string
  headerBorder: string
}

/** Sub-notes: same family as parent, small hue/L/S shifts so each mini differs slightly. */
export function miniPalette(projectHue: number, taskId: string): MiniPalette {
  const h0 = ((projectHue % 360) + 360) % 360
  const u = hashUint(taskId)
  const dh = (u % 13) - 6
  const dS = ((u >> 5) % 11) - 5
  const dL = ((u >> 10) % 13) - 6
  const h = (h0 + dh + 360) % 360
  const s1 = Math.min(86, Math.max(58, 74 + dS))
  const l1 = Math.min(90, Math.max(64, 79 + dL))
  const s2 = Math.min(82, Math.max(52, s1 - 6))
  const l2 = Math.max(52, l1 - 11)
  return {
    gradient: `linear-gradient(162deg, hsl(${h} ${s1}% ${l1}%) 0%, hsl(${h} ${s2}% ${l2}%) 100%)`,
    ink: `hsl(${h} 21% 13%)`,
    headerBorder: `hsla(${h}, 32%, 22%, 0.12)`,
  }
}

/** Ensure every project has a numeric hue (migrate saved data). */
export function boardWithProjectHues(board: BoardState): BoardState {
  const seen = new Set<number>()
  const projects: ProjectNote[] = board.projects.map((p) => {
    let hue =
      typeof p.hue === 'number' && Number.isFinite(p.hue)
        ? ((p.hue % 360) + 360) % 360
        : hueFromId(p.id)
    let rounded = Math.round(hue)
    while (seen.has(rounded)) {
      hue = (hue + 19) % 360
      rounded = Math.round(hue)
    }
    seen.add(rounded)
    return { ...p, hue }
  })
  return { ...board, projects }
}
