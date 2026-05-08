/**
 * Round-trip between stored task-note markdown and a contenteditable DOM
 * (underlined links, no raw `[label](url)` while editing).
 */

import { safeHref } from './linkifyTaskBody'

const MD = /^\[([^\]\n]*)\]\(([^)\s]+)\)/
const BARE = /^https?:\/\/[^\s<>"'`[\]{}|\\^]+/i

const M_START = '\uE001'
const M_END = '\uE002'

function trimTrailingPunct(url: string): string {
  return url.replace(/[.,;:!?)]+$/, '')
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

function escapeAttr(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

export function anchorToMarkdown(a: HTMLAnchorElement): string {
  const href = a.getAttribute('href') ?? ''
  const label = (a.textContent ?? '').replace(/\]/g, '')
  const h = safeHref(href)
  if (!h) return a.textContent ?? ''
  return `[${label}](${h})`
}

function anchorHtml(href: string, label: string): string {
  const h = escapeAttr(href)
  const title = escapeAttr(href)
  return `<a href="${h}" title="${title}" target="_blank" rel="noopener noreferrer" class="mini-body-link" contenteditable="false">${escapeHtml(label)}</a>`
}

/**
 * Stored markdown → HTML for the notes contenteditable (links + <br> only).
 */
export function markdownToNoteEditorHtml(text: string): string {
  if (!text) return ''
  const parts: string[] = []
  let i = 0
  let plainBuf = ''

  const flushPlain = () => {
    if (!plainBuf) return
    parts.push(
      plainBuf.split('\n').map(escapeHtml).join('<br>'),
    )
    plainBuf = ''
  }

  while (i < text.length) {
    const slice = text.slice(i)

    if (slice[0] === '[') {
      const m = slice.match(MD)
      if (m) {
        flushPlain()
        const href = safeHref(m[2])
        if (href) {
          const label = m[1].trim() ? m[1] : href
          parts.push(anchorHtml(href, label))
        } else {
          const fallback =
            m[1].trim() ||
            m[2]
              .trim()
              .replace(/\]/g, '')
              .slice(0, 80) ||
            'link'
          plainBuf += fallback
        }
        i += m[0].length
        continue
      }
    }

    const bm = slice.match(BARE)
    if (bm) {
      flushPlain()
      const raw = bm[0]
      const href =
        safeHref(trimTrailingPunct(raw)) ?? safeHref(raw)
      if (href) {
        const display = trimTrailingPunct(raw)
        parts.push(anchorHtml(href, display))
      } else {
        plainBuf += raw[0]
        i += 1
        continue
      }
      i += raw.length
      continue
    }

    plainBuf += text[i]
    i += 1
  }
  flushPlain()
  return parts.join('')
}

/**
 * Walk editor DOM in markdown order (text, <br> → newline, <a> → [..](..)).
 * DIV/P from the browser are unwrapped (children only) plus a trailing newline.
 */
export function serializeNoteEditorToMarkdown(root: HTMLElement): string {
  const parts: string[] = []

  function walk(n: ChildNode): void {
    if (n.nodeType === Node.TEXT_NODE) {
      parts.push(n.textContent ?? '')
      return
    }
    if (n.nodeType !== Node.ELEMENT_NODE) return
    const el = n as HTMLElement
    const t = el.tagName
    if (t === 'BR') {
      parts.push('\n')
      return
    }
    if (t === 'A') {
      parts.push(anchorToMarkdown(el as HTMLAnchorElement))
      return
    }
    if (t === 'DIV' || t === 'P') {
      for (const c of el.childNodes) walk(c as ChildNode)
      parts.push('\n')
      return
    }
    for (const c of el.childNodes) walk(c as ChildNode)
  }

  root.childNodes.forEach((c) => walk(c as ChildNode))
  return parts.join('').replace(/\n+$/, '')
}

export function getMarkdownSelectionOffsets(
  root: HTMLElement,
): { start: number; end: number } | null {
  const sel = window.getSelection()
  if (!sel || sel.rangeCount === 0) return null
  if (!root.contains(sel.anchorNode) || !root.contains(sel.focusNode))
    return null

  const r0 = sel.getRangeAt(0).cloneRange()

  if (sel.isCollapsed) {
    const r = r0.cloneRange()
    r.collapse(true)
    const marker = document.createTextNode(M_START)
    r.insertNode(marker)
    const raw = serializeNoteEditorToMarkdown(root)
    const i = raw.indexOf(M_START)
    marker.parentNode?.removeChild(marker)
    const md = raw.replaceAll(M_START, '')
    if (i < 0) return { start: md.length, end: md.length }
    return { start: i, end: i }
  }

  const endR = r0.cloneRange()
  endR.collapse(false)
  const endNode = document.createTextNode(M_END)
  endR.insertNode(endNode)

  const startR = r0.cloneRange()
  startR.collapse(true)
  const startNode = document.createTextNode(M_START)
  startR.insertNode(startNode)

  const raw = serializeNoteEditorToMarkdown(root)
  startNode.parentNode?.removeChild(startNode)
  endNode.parentNode?.removeChild(endNode)

  const si = raw.indexOf(M_START)
  const ei = raw.indexOf(M_END)
  const cleanIndex = (rawIdx: number) =>
    rawIdx < 0
      ? 0
      : raw.slice(0, rawIdx).replaceAll(M_START, '').replaceAll(M_END, '').length
  if (si < 0 && ei < 0) return { start: 0, end: 0 }
  const startMd = cleanIndex(si)
  const endMd = cleanIndex(ei)
  return { start: Math.min(startMd, endMd), end: Math.max(startMd, endMd) }
}

type DomCursor = { node: Node; offset: number }

/**
 * Map markdown character offset → DOM position (flat-ish tree from markdownToNoteEditorHtml).
 */
export function mdOffsetToDomCursor(
  root: HTMLElement,
  mdPos: number,
): DomCursor | null {
  const rem = { n: mdPos }

  function walkFragment(parent: HTMLElement): DomCursor | null {
    for (const child of parent.childNodes) {
      const c = child as ChildNode
      if (c.nodeType === Node.TEXT_NODE) {
        const len = (c as Text).length
        if (rem.n <= len) return { node: c, offset: rem.n }
        rem.n -= len
        continue
      }
      if (c.nodeType !== Node.ELEMENT_NODE) continue
      const el = c as HTMLElement
      const t = el.tagName
      if (t === 'BR') {
        if (rem.n === 0) {
          const p = el.parentNode!
          const idx = [...p.childNodes].indexOf(c)
          return { node: p, offset: idx }
        }
        rem.n -= 1
        if (rem.n === 0) {
          const p = el.parentNode!
          const idx = [...p.childNodes].indexOf(c)
          return { node: p, offset: idx + 1 }
        }
        continue
      }
      if (t === 'A') {
        const L = anchorToMarkdown(el as HTMLAnchorElement).length
        if (rem.n <= L) {
          const p = el.parentNode!
          const idx = [...p.childNodes].indexOf(c)
          if (rem.n === 0) return { node: p, offset: idx }
          return { node: p, offset: idx + 1 }
        }
        rem.n -= L
        continue
      }
      if (t === 'DIV' || t === 'P') {
        const hit = walkFragment(el)
        if (hit) return hit
        if (rem.n > 0) rem.n -= 1
        continue
      }
      const hit = walkFragment(el)
      if (hit) return hit
    }
    return null
  }

  const hit = walkFragment(root)
  if (hit) return hit
  const last = root.lastChild
  if (last?.nodeType === Node.TEXT_NODE) {
    return { node: last, offset: (last as Text).length }
  }
  return { node: root, offset: root.childNodes.length }
}

export function setMarkdownSelectionOffsets(
  root: HTMLElement,
  start: number,
  end: number,
): void {
  const a = mdOffsetToDomCursor(root, start)
  const b = mdOffsetToDomCursor(root, end)
  if (!a || !b) return
  const sel = window.getSelection()
  if (!sel) return
  try {
    const rng = document.createRange()
    rng.setStart(a.node, a.offset)
    rng.setEnd(b.node, b.offset)
    sel.removeAllRanges()
    sel.addRange(rng)
  } catch {
    /* invalid range */
  }
}

export function normalizeEditorDomFromMarkdown(root: HTMLElement, md: string): void {
  root.innerHTML = markdownToNoteEditorHtml(md)
}
