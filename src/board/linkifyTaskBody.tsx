import type { ReactNode } from 'react'

const MD = /^\[([^\]\n]*)\]\(([^)\s]+)\)/
const BARE = /^https?:\/\/[^\s<>"'`[\]{}|\\^]+/i

/** Allowed http(s) targets for links in task notes. */
export function safeHref(raw: string): string | null {
  const t = raw.trim()
  if (t.length > 2048) return null
  if (!/^https?:\/\//i.test(t)) return null
  try {
    const u = new URL(t)
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null
    return u.href
  } catch {
    return null
  }
}

function trimTrailingPunct(url: string): string {
  return url.replace(/[.,;:!?)]+$/, '')
}

/** Strip characters invalid inside our `[label](url)` subset. */
export function sanitizeMarkdownLinkLabel(selection: string): string {
  return selection
    .replace(/\]/g, '')
    .replace(/\r\n/g, '\n')
    .replace(/\n/g, ' ')
    .trim()
}

/**
 * If the user pastes an http(s) URL with non-empty selection, replace the
 * selection with `[label](url)` (label from selection, or hostname fallback).
 */
export function tryWrapSelectionWithPastedLink(
  value: string,
  selectionStart: number,
  selectionEnd: number,
  pastedRaw: string,
): { nextValue: string; selectionStart: number; selectionEnd: number } | null {
  const pasted = pastedRaw.trim()
  const href = safeHref(pasted)
  if (!href) return null
  if (selectionStart === selectionEnd) return null

  let label = sanitizeMarkdownLinkLabel(
    value.slice(selectionStart, selectionEnd),
  )
  if (!label) {
    try {
      label = new URL(href).hostname.replace(/^www\./i, '')
    } catch {
      label = 'link'
    }
  }

  const before = value.slice(0, selectionStart)
  const after = value.slice(selectionEnd)
  const insert = `[${label}](${href})`
  const nextValue = before + insert + after
  const caret = before.length + insert.length
  return { nextValue, selectionStart: caret, selectionEnd: caret }
}

/**
 * Renders task body text with clickable http(s) URLs and markdown [label](url) links.
 * Only http/https hrefs are emitted; invalid `[...](...)` is shown as plain label, not raw markdown.
 */
export function linkifyTaskBodyText(text: string): ReactNode {
  if (!text) return null
  const out: ReactNode[] = []
  let i = 0
  let k = 0

  while (i < text.length) {
    const slice = text.slice(i)

    if (slice[0] === '[') {
      const m = slice.match(MD)
      if (m) {
        const href = safeHref(m[2])
        if (href) {
          const label = m[1].trim() ? m[1] : href
          out.push(
            <a
              key={k++}
              href={href}
              title={href}
              target="_blank"
              rel="noopener noreferrer"
              className="mini-body-link"
              onPointerDown={(e) => e.stopPropagation()}
            >
              {label}
            </a>,
          )
          i += m[0].length
          continue
        }
        const fallback =
          m[1].trim() ||
          sanitizeMarkdownLinkLabel(m[2]) ||
          'link'
        out.push(fallback)
        i += m[0].length
        continue
      }
    }

    const bm = slice.match(BARE)
    if (bm) {
      const raw = bm[0]
      const href = safeHref(trimTrailingPunct(raw)) ?? safeHref(raw)
      if (href) {
        const display = trimTrailingPunct(raw)
        out.push(
          <a
            key={k++}
            href={href}
            title={href}
            target="_blank"
            rel="noopener noreferrer"
            className="mini-body-link"
            onPointerDown={(e) => e.stopPropagation()}
          >
            {display}
          </a>,
        )
        i += raw.length
        continue
      }
    }

    out.push(text[i])
    i += 1
  }

  return <>{out}</>
}

/**
 * Unique http(s) links in document order: `[label](url)` when parsed from
 * markdown (label sanitized), otherwise the bare URL string — same shapes
 * users store in task bodies.
 */
export function extractHttpLinksFromTaskBody(text: string): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  let i = 0

  while (i < text.length) {
    const slice = text.slice(i)

    if (slice[0] === '[') {
      const m = slice.match(MD)
      if (m) {
        const href = safeHref(m[2])
        if (href && !seen.has(href)) {
          seen.add(href)
          const label = m[1].trim()
            ? sanitizeMarkdownLinkLabel(m[1])
            : href
          out.push(`[${label}](${href})`)
        }
        i += m[0].length
        continue
      }
    }

    const bm = slice.match(BARE)
    if (bm) {
      const raw = bm[0]
      const href = safeHref(trimTrailingPunct(raw)) ?? safeHref(raw)
      if (href && !seen.has(href)) {
        seen.add(href)
        out.push(href)
      }
      i += raw.length
      continue
    }

    i += 1
  }

  return out
}
