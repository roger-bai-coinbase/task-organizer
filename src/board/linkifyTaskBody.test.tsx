import { describe, expect, it } from 'vitest'
import {
  extractHttpLinksFromTaskBody,
  safeHref,
  sanitizeMarkdownLinkLabel,
  tryWrapSelectionWithPastedLink,
} from './linkifyTaskBody'

describe('linkifyTaskBody', () => {
  it('allows only valid http and https hrefs', () => {
    expect(safeHref('https://example.com/a?b=1')).toBe(
      'https://example.com/a?b=1',
    )
    expect(safeHref('javascript:alert(1)')).toBeNull()
    expect(safeHref('ftp://example.com/file')).toBeNull()
    expect(safeHref(`https://example.com/${'a'.repeat(2050)}`)).toBeNull()
  })

  it('sanitizes markdown link labels', () => {
    expect(sanitizeMarkdownLinkLabel('hello]\nworld')).toBe('hello world')
  })

  it('wraps selected text when an http link is pasted', () => {
    expect(tryWrapSelectionWithPastedLink('Open docs', 5, 9, 'https://docs.example')).toEqual({
      nextValue: 'Open [docs](https://docs.example/)',
      selectionStart: 34,
      selectionEnd: 34,
    })
  })

  it('extracts unique markdown and bare links in document order', () => {
    expect(
      extractHttpLinksFromTaskBody(
        '[Spec](https://example.com/spec) and https://example.com/spec and https://example.com/two.',
      ),
    ).toEqual([
      '[Spec](https://example.com/spec)',
      'https://example.com/two',
    ])
  })
})
