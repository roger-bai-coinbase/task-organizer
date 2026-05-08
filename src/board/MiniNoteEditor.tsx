import {
  useCallback,
  useLayoutEffect,
  useRef,
  forwardRef,
} from 'react'
import type { MutableRefObject, Ref } from 'react'
import {
  getMarkdownSelectionOffsets,
  markdownToNoteEditorHtml,
  normalizeEditorDomFromMarkdown,
  serializeNoteEditorToMarkdown,
  setMarkdownSelectionOffsets,
} from './miniNoteEditorDom'
import {
  applyMiniNoteEnter,
  applyMiniNoteTab,
  normalizeMiniBullets,
} from './miniNoteBulletKeys'
import { tryWrapSelectionWithPastedLink } from './linkifyTaskBody'

export type MiniNoteEditorProps = {
  value: string
  onChange: (next: string) => void
  onFocus?: (e: React.FocusEvent<HTMLDivElement>) => void
  className?: string
  placeholder?: string
  'aria-label'?: string
}

export const MiniNoteEditor = forwardRef<HTMLDivElement, MiniNoteEditorProps>(
  function MiniNoteEditor(
    {
      value,
      onChange,
      onFocus,
      className = '',
      placeholder = 'Notes…',
      'aria-label': ariaLabel,
    },
    ref,
  ) {
    const innerRef = useRef<HTMLDivElement | null>(null)

    const assignRef = useCallback((r: Ref<HTMLDivElement> | undefined, el: HTMLDivElement | null) => {
      if (r == null) return
      if (typeof r === 'function') r(el)
      else (r as MutableRefObject<HTMLDivElement | null>).current = el
    }, [])

    const setRefs = useCallback(
      (el: HTMLDivElement | null) => {
        innerRef.current = el
        assignRef(ref, el)
      },
      [ref, assignRef],
    )

    useLayoutEffect(() => {
      const el = innerRef.current
      if (!el) return
      const cur = normalizeMiniBullets(serializeNoteEditorToMarkdown(el))
      if (cur === normalizeMiniBullets(value)) return
      normalizeEditorDomFromMarkdown(el, value)
    }, [value])

    const syncFromDom = useCallback(() => {
      const el = innerRef.current
      if (!el) return
      let md = serializeNoteEditorToMarkdown(el)
      md = normalizeMiniBullets(md)
      if (el.querySelector('div,p')) {
        const off = getMarkdownSelectionOffsets(el)
        el.innerHTML = markdownToNoteEditorHtml(md)
        if (off) {
          requestAnimationFrame(() =>
            setMarkdownSelectionOffsets(el, off.start, off.end),
          )
        }
      }
      onChange(md)
    }, [onChange])

    return (
      <div className="mini-text-editor-shell">
        <div
          ref={setRefs}
          className={`mini-text mini-text--editable ${className}`.trim()}
          contentEditable
          suppressContentEditableWarning
          role="textbox"
          aria-multiline="true"
          aria-label={ariaLabel ?? 'Task notes'}
          data-placeholder={placeholder}
          onFocus={onFocus}
          onInput={syncFromDom}
          onKeyDown={(e) => {
            const el = innerRef.current
            if (!el) return

            if (e.key === 'Enter') {
              if (!e.shiftKey) {
                const md = serializeNoteEditorToMarkdown(el)
                const o = getMarkdownSelectionOffsets(el)
                if (o && o.start === o.end) {
                  const r = applyMiniNoteEnter(md, o.start, o.end)
                  if (r.handled) {
                    e.preventDefault()
                    const v = normalizeMiniBullets(r.value)
                    normalizeEditorDomFromMarkdown(el, v)
                    requestAnimationFrame(() =>
                      setMarkdownSelectionOffsets(
                        el,
                        r.selectionStart,
                        r.selectionEnd,
                      ),
                    )
                    onChange(v)
                    return
                  }
                }
              }
              e.preventDefault()
              if (!document.execCommand('insertLineBreak', false)) {
                document.execCommand('insertHTML', false, '<br>')
              }
              requestAnimationFrame(() => syncFromDom())
              return
            }

            if (e.key === 'Tab') {
              const md = serializeNoteEditorToMarkdown(el)
              const o = getMarkdownSelectionOffsets(el)
              if (!o || o.start !== o.end) return
              const r = applyMiniNoteTab(md, o.start, o.end, e.shiftKey)
              if (r.handled) {
                e.preventDefault()
                const v = normalizeMiniBullets(r.value)
                normalizeEditorDomFromMarkdown(el, v)
                requestAnimationFrame(() =>
                  setMarkdownSelectionOffsets(
                    el,
                    r.selectionStart,
                    r.selectionEnd,
                  ),
                )
                onChange(v)
              }
            }
          }}
          onPaste={(e) => {
            const el = innerRef.current
            if (!el) return
            const pasted = e.clipboardData.getData('text/plain')
            const md = serializeNoteEditorToMarkdown(el)
            const o = getMarkdownSelectionOffsets(el)
            if (!o) return
            const wrapped = tryWrapSelectionWithPastedLink(
              md,
              o.start,
              o.end,
              pasted,
            )
            if (wrapped) {
              e.preventDefault()
              const v = normalizeMiniBullets(wrapped.nextValue)
              normalizeEditorDomFromMarkdown(el, v)
              requestAnimationFrame(() =>
                setMarkdownSelectionOffsets(
                  el,
                  wrapped.selectionStart,
                  wrapped.selectionEnd,
                ),
              )
              onChange(v)
              return
            }
            e.preventDefault()
            document.execCommand('insertText', false, pasted)
            syncFromDom()
          }}
        />
        {!value.trim() ? (
          <span className="mini-text-editable-placeholder" aria-hidden>
            {placeholder}
          </span>
        ) : null}
      </div>
    )
  },
)
