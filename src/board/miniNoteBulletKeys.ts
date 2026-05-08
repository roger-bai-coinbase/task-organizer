/**
 * Mini-note bullets: Google Docs–style nesting (two spaces per level). Markers
 * use glyphs sized like Docs list bullets (• ◦ ▪ ▫), not the oversized ●○■□
 * block. `- ` at line start normalizes to the glyph for that level.
 */

/** Disc / hollow / filled square / hollow square — Docs-like weight at 11pt body. */
const GOOGLE_DOCS_MARKERS = ['\u2022', '\u25E6', '\u25AA', '\u25AB'] as const

/** Older large cycle + hyphen; still parsed, normalized to GOOGLE_DOCS_MARKERS. */
const LEGACY_MARKER_CHARS = new Set([
  '-',
  '\u25CF',
  '\u25CB',
  '\u25A0',
  '\u25A1',
])

function isBulletMarkerChar(ch: string): boolean {
  return (
    (GOOGLE_DOCS_MARKERS as readonly string[]).includes(ch) ||
    LEGACY_MARKER_CHARS.has(ch)
  )
}

function markerCharForLevel(level: number): string {
  const n = GOOGLE_DOCS_MARKERS.length
  const i = ((level % n) + n) % n
  return GOOGLE_DOCS_MARKERS[i]
}

/** Visible marker: one Unicode char + ASCII space (same UTF-16 length as `- `). */
export function markerForLevel(level: number): string {
  return `${markerCharForLevel(level)} `
}

export function bulletLevelFromIndent(indent: string): number {
  return Math.floor(indent.length / 2)
}

/** Match a bullet line: leading spaces + known marker char + space + body. */
export function parseBulletLine(
  line: string,
): { indent: string; body: string } | null {
  const m = line.match(/^(\s*)(.) (.*)$/)
  if (!m) return null
  const ch = m[2]
  if (!isBulletMarkerChar(ch)) return null
  return { indent: m[1], body: m[3] }
}

export function bulletPrefixForIndent(indent: string): string {
  return indent + markerForLevel(bulletLevelFromIndent(indent))
}

function bulletPrefixLen(indent: string): number {
  return bulletPrefixForIndent(indent).length
}

/** Re-sync every bullet line’s glyph to its indent level (• ◦ ▪ ▫ cycle). */
export function normalizeMiniBullets(text: string): string {
  if (!text) return text
  return text
    .split('\n')
    .map((line) => {
      const p = parseBulletLine(line)
      if (!p) return line
      return bulletPrefixForIndent(p.indent) + p.body
    })
    .join('\n')
}

export type BulletKeyHandled = {
  handled: true
  value: string
  selectionStart: number
  selectionEnd: number
}

export type BulletKeyResult = { handled: false } | BulletKeyHandled

function lineBounds(value: string, pos: number): { start: number; end: number } {
  const start = value.lastIndexOf('\n', pos - 1) + 1
  const nl = value.indexOf('\n', pos)
  const end = nl === -1 ? value.length : nl
  return { start, end }
}

/**
 * Enter: continue bullet on the next line; on an empty bullet line, outdent one
 * level or remove the bullet. Shift+Enter is left unhandled (plain newline).
 */
export function applyMiniNoteEnter(
  value: string,
  selectionStart: number,
  selectionEnd: number,
): BulletKeyResult {
  if (selectionStart !== selectionEnd) return { handled: false }

  const { start: lineStart, end: lineEnd } = lineBounds(value, selectionStart)
  const line = value.slice(lineStart, lineEnd)
  const p = parseBulletLine(line)
  if (!p) return { handled: false }

  const { indent, body } = p
  const cursorInLine = selectionStart - lineStart
  const prefixLen = bulletPrefixLen(indent)

  const isEmptyBullet = body.trim() === ''
  if (isEmptyBullet) {
    if (indent.length >= 2) {
      const newIndent = indent.slice(0, -2)
      const newLine = bulletPrefixForIndent(newIndent)
      const next =
        value.slice(0, lineStart) + newLine + value.slice(lineEnd)
      const pos = lineStart + newLine.length
      return { handled: true, value: next, selectionStart: pos, selectionEnd: pos }
    }
    const next = value.slice(0, lineStart) + value.slice(lineEnd)
    const pos = lineStart
    return { handled: true, value: next, selectionStart: pos, selectionEnd: pos }
  }

  if (cursorInLine < prefixLen) return { handled: false }

  const left = line.slice(0, cursorInLine)
  const right = line.slice(cursorInLine)
  const prefix = bulletPrefixForIndent(indent)
  const next =
    value.slice(0, lineStart) + left + '\n' + prefix + right + value.slice(lineEnd)
  const pos = lineStart + left.length + 1 + prefix.length
  return { handled: true, value: next, selectionStart: pos, selectionEnd: pos }
}

/** Tab: indent bullet line; Shift+Tab: outdent. */
export function applyMiniNoteTab(
  value: string,
  selectionStart: number,
  selectionEnd: number,
  shiftKey: boolean,
): BulletKeyResult {
  if (selectionStart !== selectionEnd) return { handled: false }

  const { start: lineStart, end: lineEnd } = lineBounds(value, selectionStart)
  const line = value.slice(lineStart, lineEnd)
  const p = parseBulletLine(line)
  if (!p) return { handled: false }

  const { indent, body } = p

  if (shiftKey) {
    if (indent.length < 2) return { handled: false }
    const newIndent = indent.slice(0, -2)
    const newLine = bulletPrefixForIndent(newIndent) + body
    const next =
      value.slice(0, lineStart) + newLine + value.slice(lineEnd)
    const cur = selectionStart - lineStart
    const pos = lineStart + Math.max(0, cur - 2)
    return { handled: true, value: next, selectionStart: pos, selectionEnd: pos }
  }

  const newIndent = `  ${indent}`
  const newLine = bulletPrefixForIndent(newIndent) + body
  const next = value.slice(0, lineStart) + newLine + value.slice(lineEnd)
  const pos = selectionStart + 2
  return { handled: true, value: next, selectionStart: pos, selectionEnd: pos }
}
