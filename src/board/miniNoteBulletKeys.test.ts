import { describe, expect, it } from 'vitest'
import {
  applyMiniNoteEnter,
  applyMiniNoteTab,
  normalizeMiniBullets,
} from './miniNoteBulletKeys'

describe('miniNoteBulletKeys', () => {
  it('normalizes legacy and hyphen markers to the current glyph cycle', () => {
    expect(normalizeMiniBullets('- Root\n  ● Child\n    ○ Grandchild')).toBe(
      '• Root\n  ◦ Child\n    ▪ Grandchild',
    )
  })

  it('continues a bullet when pressing enter inside a bullet line', () => {
    expect(applyMiniNoteEnter('• First', 7, 7)).toEqual({
      handled: true,
      value: '• First\n• ',
      selectionStart: 10,
      selectionEnd: 10,
    })
  })

  it('outdents an empty nested bullet when pressing enter', () => {
    expect(applyMiniNoteEnter('  ◦ ', 4, 4)).toEqual({
      handled: true,
      value: '• ',
      selectionStart: 2,
      selectionEnd: 2,
    })
  })

  it('indents and outdents a bullet with tab keys', () => {
    expect(applyMiniNoteTab('• Item', 3, 3, false)).toEqual({
      handled: true,
      value: '  ◦ Item',
      selectionStart: 5,
      selectionEnd: 5,
    })
    expect(applyMiniNoteTab('  ◦ Item', 5, 5, true)).toEqual({
      handled: true,
      value: '• Item',
      selectionStart: 3,
      selectionEnd: 3,
    })
  })
})
