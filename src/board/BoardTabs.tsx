import type { CSSProperties, PointerEvent } from 'react'
import { hueFromId } from './colors'
import type { WorkspaceState } from './types'

type MutableValueRef<T> = { current: T }

export type BoardTabReorderView = {
  boardId: string
  hoverIndex: number
}

export type BoardTabsProps = {
  workspace: WorkspaceState
  editingBoardTitleId: string | null
  boardTabReorder: BoardTabReorderView | null
  boardTabTitleInputRef: MutableValueRef<HTMLInputElement | null>
  boardTabWrapRefs: MutableValueRef<Record<string, HTMLDivElement | null>>
  suppressBoardTabClickRef: MutableValueRef<boolean>
  beginPendingBoardTabDrag: (
    e: PointerEvent,
    boardId: string,
    fromIndex: number,
  ) => void
  updateBoardTitle: (boardId: string, title: string) => void
  switchBoard: (id: string) => void
  setEditingBoardTitleId: (id: string | null) => void
  removeBoard: (boardId: string) => void
  addBoard: () => void
}

export function BoardTabs({
  workspace,
  editingBoardTitleId,
  boardTabReorder,
  boardTabTitleInputRef,
  boardTabWrapRefs,
  suppressBoardTabClickRef,
  beginPendingBoardTabDrag,
  updateBoardTitle,
  switchBoard,
  setEditingBoardTitleId,
  removeBoard,
  addBoard,
}: BoardTabsProps) {
  return (
    <div
      className={
        boardTabReorder
          ? 'board-toolbar-boards board-toolbar-boards--reordering'
          : 'board-toolbar-boards'
      }
      role="tablist"
      aria-label="Boards"
    >
      {workspace.boards.map((b, boardIndex) => (
        <div
          key={b.id}
          ref={(el) => {
            boardTabWrapRefs.current[b.id] = el
          }}
          className={[
            'board-tab-wrap',
            'board-tab-wrap--colored',
            boardTabReorder?.boardId === b.id
              ? 'board-tab-wrap--dragging'
              : '',
            boardTabReorder &&
            boardTabReorder.hoverIndex === boardIndex &&
            boardTabReorder.boardId !== b.id
              ? 'board-tab-wrap--drop-before'
              : '',
            boardTabReorder &&
            boardTabReorder.hoverIndex === workspace.boards.length &&
            boardIndex === workspace.boards.length - 1
              ? 'board-tab-wrap--drop-after'
              : '',
          ]
            .filter(Boolean)
            .join(' ')}
          style={
            { ['--board-tab-h']: String(hueFromId(b.id)) } as CSSProperties
          }
        >
          {editingBoardTitleId === b.id ? (
            <input
              ref={boardTabTitleInputRef}
              className="board-tab-input board-tab-input--colored"
              value={b.title}
              onChange={(e) => updateBoardTitle(b.id, e.target.value)}
              placeholder="Board title"
              aria-label="Board title"
              onPointerDown={(e) => e.stopPropagation()}
              onBlur={() => setEditingBoardTitleId(null)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  ;(e.target as HTMLInputElement).blur()
                }
                if (e.key === 'Escape') {
                  e.preventDefault()
                  setEditingBoardTitleId(null)
                }
              }}
            />
          ) : (
            <button
              type="button"
              role="tab"
              aria-selected={b.id === workspace.activeBoardId}
              className={
                b.id === workspace.activeBoardId
                  ? 'board-tab board-tab--colored board-tab--active'
                  : 'board-tab board-tab--colored'
              }
              title="Drag to reorder · Double-click to rename"
              onPointerDown={(e) =>
                beginPendingBoardTabDrag(e, b.id, boardIndex)
              }
              onClick={() => {
                if (suppressBoardTabClickRef.current) {
                  suppressBoardTabClickRef.current = false
                  return
                }
                switchBoard(b.id)
              }}
              onDoubleClick={(e) => {
                e.preventDefault()
                setEditingBoardTitleId(b.id)
              }}
            >
              {b.title.trim() || 'Untitled board'}
            </button>
          )}
          {workspace.boards.length > 1 ? (
            <button
              type="button"
              className="icon-btn board-tab-remove danger"
              title="Remove board"
              aria-label={`Remove board ${b.title.trim() || 'Untitled board'}`}
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation()
                removeBoard(b.id)
              }}
            >
              ×
            </button>
          ) : null}
        </div>
      ))}
      <button
        type="button"
        className="board-tab board-tab--add"
        onClick={addBoard}
        title="Add another board"
      >
        + Board
      </button>
    </div>
  )
}
