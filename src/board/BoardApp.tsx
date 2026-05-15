import type { CSSProperties } from 'react'
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { flushSync } from 'react-dom'
import './board.css'
import { newId } from './ids'
import {
  boardWithProjectHues,
  hueFromId,
  miniPalette,
  pickDistinctHue,
  projectPalette,
} from './colors'
import {
  createWeeklyReportOnDisk,
  loadTaskEventsFromDisk,
  loadTaskEventsFromLocal,
  loadWorkspaceFromDisk,
  loadWorkspaceFromLocal,
  saveTaskEventsToDisk,
  saveTaskEventsToLocal,
  saveWorkspaceToDisk,
  saveWorkspaceToLocal,
  flattenWorkspaceForEvents,
} from './storage'
import {
  applyCornerResize,
  applyEdgeResize,
  isResizeCorner,
  type RectStart,
  type ResizeHandle,
} from './resizeApply'
import type {
  BoardState,
  BoardTheme,
  ProjectNote,
  TaskNote,
  WorkspaceState,
} from './types'
import { linkifyTaskBodyText } from './linkifyTaskBody'
import { MiniNoteEditor } from './MiniNoteEditor'
import { normalizeMiniBullets } from './miniNoteBulletKeys'
import {
  buildWeeklyDiffText,
  collectTaskEvents,
  mergeTaskEvents,
  type TaskChangeEvent,
} from './taskEvents'

const BOARD_W = 3600
const BOARD_H = 2800
const DEF_PROJECT_W = 440
const DEF_PROJECT_H = 380
const DEF_MINI_W = 132
const DEF_MINI_H = 100
const PROJECT_MIN_W = 280
const PROJECT_MAX_W = 960
const PROJECT_MIN_H = 200
const PROJECT_MAX_H = 1400
const MINI_MIN_W = 100
const MINI_MAX_W = 420
const MINI_MIN_H = 88
const MINI_MAX_H = 720
/** Title + created date row in mini header (~2 lines). */
const MINI_HEADER_APPROX = 54
const MINI_BODY_PAD_V = 12
const MINI_BODY_PAD_H = 12
const SAVE_MS = 400
const REPORT_NOTICE_MS = 7000
const DRAG_THRESHOLD_SQ = 6 * 6
const HEADER_DOUBLE_TAP_MS = 420

function taskEditKey(projectId: string, taskId: string): string {
  return `${projectId}:${taskId}`
}

function withTaskTitles(board: BoardState): BoardState {
  return {
    ...board,
    projects: board.projects.map((p) => ({
      ...p,
      tasks: p.tasks.map((t) => ({
        ...t,
        title:
          typeof (t as TaskNote & { title?: unknown }).title === 'string'
            ? (t as TaskNote).title
            : '',
      })),
    })),
  }
}

function withNormalizedMiniBullets(board: BoardState): BoardState {
  return {
    ...board,
    projects: board.projects.map((p) => ({
      ...p,
      tasks: p.tasks.map((t) => ({
        ...t,
        text: normalizeMiniBullets(
          typeof (t as TaskNote & { text?: unknown }).text === 'string'
            ? (t as TaskNote).text
            : '',
        ),
      })),
    })),
  }
}

function withNoteSizes(board: BoardState): BoardState {
  return {
    ...board,
    projects: board.projects.map((p) => {
      const pr = p as ProjectNote & { width?: unknown; height?: unknown }
      const width =
        typeof pr.width === 'number' && Number.isFinite(pr.width) && pr.width > 0
          ? pr.width
          : DEF_PROJECT_W
      const height =
        typeof pr.height === 'number' &&
        Number.isFinite(pr.height) &&
        pr.height > 0
          ? pr.height
          : DEF_PROJECT_H
      return {
        ...p,
        width,
        height,
        tasks: p.tasks.map((t) => {
          const tr = t as TaskNote & { width?: unknown; height?: unknown }
          const tw =
            typeof tr.width === 'number' &&
            Number.isFinite(tr.width) &&
            tr.width > 0
              ? tr.width
              : DEF_MINI_W
          const th =
            typeof tr.height === 'number' &&
            Number.isFinite(tr.height) &&
            tr.height > 0
              ? tr.height
              : DEF_MINI_H
          return { ...t, width: tw, height: th }
        }),
      }
    }),
  }
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n))
}

function formatCreatedLabel(iso: string): string {
  const ms = Date.parse(iso)
  if (Number.isNaN(ms)) return ''
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  }).format(new Date(ms))
}

/** Backfill missing `createdAt` on projects and tasks (persisted on next save). */
function withCreatedAt(board: BoardState): BoardState {
  const fallback = new Date().toISOString()
  return {
    ...board,
    projects: board.projects.map((p) => {
      const rawP = p as ProjectNote & { createdAt?: unknown }
      const projectCreated =
        typeof rawP.createdAt === 'string' &&
        !Number.isNaN(Date.parse(rawP.createdAt))
          ? rawP.createdAt
          : fallback
      return {
        ...p,
        createdAt: projectCreated,
        tasks: p.tasks.map((t) => {
          const rawT = t as TaskNote & { createdAt?: unknown }
          const taskCreated =
            typeof rawT.createdAt === 'string' &&
            !Number.isNaN(Date.parse(rawT.createdAt))
              ? rawT.createdAt
              : fallback
          return { ...t, createdAt: taskCreated }
        }),
      }
    }),
  }
}

/** Drop duplicate project / task ids (bad merges or hand-edited JSON). */
function dedupeBoard(board: BoardState): BoardState {
  const seenProjects = new Set<string>()
  return {
    ...board,
    projects: board.projects
      .filter((p) => {
        if (seenProjects.has(p.id)) return false
        seenProjects.add(p.id)
        return true
      })
      .map((p) => {
        const seenTasks = new Set<string>()
        return {
          ...p,
          tasks: p.tasks.filter((t) => {
            if (seenTasks.has(t.id)) return false
            seenTasks.add(t.id)
            return true
          }),
        }
      }),
  }
}

/** Layer height when DOM not ready: project body minus header + add row + padding. */
function estimatedMiniLayerHeight(project: ProjectNote): number {
  const header = 56
  const addRow = 44
  const bodyPad = 20
  return Math.max(
    100,
    project.height - header - addRow - bodyPad,
  )
}

type AxisRect = { x: number; y: number; w: number; h: number }

function rectsOverlap(a: AxisRect, b: AxisRect): boolean {
  return !(
    a.x + a.w <= b.x ||
    b.x + b.w <= a.x ||
    a.y + a.h <= b.y ||
    b.y + b.h <= a.y
  )
}

const PLACE_GAP = 12

/** Inner width of the mini layer (project body horizontal padding). */
function miniLayerInnerWidth(project: ProjectNote): number {
  return Math.max(60, project.width - 20)
}

/** Enlarge the project so a task rect fits inside the mini layer (matches drag/resize bounds). */
function growProjectToFitTask(project: ProjectNote, task: TaskNote): ProjectNote {
  let { width, height, x, y } = project
  const innerW = miniLayerInnerWidth(project)
  const innerH = estimatedMiniLayerHeight(project)
  const right = task.x + task.width
  const bottom = task.y + task.height

  if (right > innerW) {
    width = Math.max(width, right + 20)
    width = clamp(width, PROJECT_MIN_W, PROJECT_MAX_W)
  }
  if (bottom > innerH) {
    height = Math.max(height, bottom + 120)
    height = clamp(height, PROJECT_MIN_H, PROJECT_MAX_H)
  }

  x = clamp(x, 0, BOARD_W - width)
  y = clamp(y, 0, BOARD_H - height)
  return { ...project, width, height, x, y }
}

function expandProjectToFitAllTasks(project: ProjectNote): ProjectNote {
  let p = project
  for (const t of p.tasks) {
    p = growProjectToFitTask(p, t)
  }
  return p
}

function findFreeProjectPosition(
  projects: ProjectNote[],
  w: number,
  h: number,
): { x: number; y: number } {
  const obstacles: AxisRect[] = projects.map((p) => ({
    x: p.x - PLACE_GAP,
    y: p.y - PLACE_GAP,
    w: p.width + 2 * PLACE_GAP,
    h: p.height + 2 * PLACE_GAP,
  }))
  const step = 28
  for (let y = 40; y <= BOARD_H - h - 24; y += step) {
    for (let x = 40; x <= BOARD_W - w - 24; x += step) {
      const c: AxisRect = { x, y, w, h }
      if (!obstacles.some((o) => rectsOverlap(c, o))) return { x, y }
    }
  }
  const n = projects.length
  return {
    x: clamp(40 + (n * 41) % Math.max(1, BOARD_W - w - 40), 0, BOARD_W - w),
    y: clamp(40 + (n * 59) % Math.max(1, BOARD_H - h - 40), 0, BOARD_H - h),
  }
}

/** First top-left slot for a tw×th mini inside the layer, or null if it cannot fit. */
function findFreeTaskPosition(
  project: ProjectNote,
  tw: number,
  th: number,
  margin: number,
): { x: number; y: number } | null {
  const W = miniLayerInnerWidth(project)
  const H = estimatedMiniLayerHeight(project)
  if (W < tw + 16 || H < th + 16) return null
  const obstacles: AxisRect[] = project.tasks.map((t) => ({
    x: t.x - margin,
    y: t.y - margin,
    w: t.width + 2 * margin,
    h: t.height + 2 * margin,
  }))
  const step = 18
  for (let y = 8; y <= H - th - 8; y += step) {
    for (let x = 12; x <= W - tw - 12; x += step) {
      const c: AxisRect = { x, y, w: tw, h: th }
      if (!obstacles.some((o) => rectsOverlap(c, o))) return { x, y }
    }
  }
  for (let y = 8; y <= H - th - 8; y += 6) {
    for (let x = 12; x <= W - tw - 12; x += 6) {
      const c: AxisRect = { x, y, w: tw, h: th }
      if (!obstacles.some((o) => rectsOverlap(c, o))) return { x, y }
    }
  }
  return null
}

function defaultState(): BoardState {
  const a = newId()
  const b = newId()
  const hueA = pickDistinctHue([])
  const hueB = pickDistinctHue([hueA])
  const p1 = new Date('2026-02-01T10:00:00.000Z').toISOString()
  const p2 = new Date('2026-02-03T14:30:00.000Z').toISOString()
  const t1 = new Date('2026-02-01T11:00:00.000Z').toISOString()
  const t2 = new Date('2026-02-02T09:15:00.000Z').toISOString()
  const t3 = new Date('2026-02-03T16:00:00.000Z').toISOString()
  return {
    theme: 'blackboard',
    projects: [
      {
        id: a,
        title: 'Website refresh',
        createdAt: p1,
        hue: hueA,
        x: 120,
        y: 100,
        width: DEF_PROJECT_W,
        height: DEF_PROJECT_H,
        tasks: [
          {
            id: newId(),
            title: 'Wireframes',
            text: 'IA + layout notes',
            createdAt: t1,
            x: 16,
            y: 52,
            width: DEF_MINI_W,
            height: DEF_MINI_H,
          },
          {
            id: newId(),
            title: 'Copy deck',
            text: 'Homepage hero',
            createdAt: t2,
            x: 168,
            y: 120,
            width: DEF_MINI_W,
            height: DEF_MINI_H,
          },
        ],
      },
      {
        id: b,
        title: 'Personal',
        createdAt: p2,
        hue: hueB,
        x: 620,
        y: 140,
        width: DEF_PROJECT_W,
        height: DEF_PROJECT_H,
        tasks: [
          {
            id: newId(),
            title: 'Health',
            text: 'Book dentist',
            createdAt: t3,
            x: 24,
            y: 52,
            width: DEF_MINI_W,
            height: DEF_MINI_H,
          },
        ],
      },
    ],
  }
}

function normalizeWorkspace(ws: WorkspaceState): WorkspaceState {
  const boards = ws.boards.map((entry) => {
    const canvas: BoardState = { theme: entry.theme, projects: entry.projects }
    const n = withNoteSizes(
      withTaskTitles(
        withNormalizedMiniBullets(
          dedupeBoard(withCreatedAt(boardWithProjectHues(canvas))),
        ),
      ),
    )
    return { ...entry, theme: n.theme, projects: n.projects }
  })
  let activeBoardId = ws.activeBoardId
  if (!boards.some((b) => b.id === activeBoardId) && boards.length > 0) {
    activeBoardId = boards[0].id
  }
  return { boards, activeBoardId }
}

function defaultWorkspace(): WorkspaceState {
  const b = defaultState()
  const id = newId()
  return {
    boards: [{ id, title: 'Board', theme: b.theme, projects: b.projects }],
    activeBoardId: id,
  }
}

type DragProject = {
  kind: 'project'
  id: string
  pointerId: number
  startClientX: number
  startClientY: number
  startX: number
  startY: number
}

type DragTask = {
  kind: 'task'
  projectId: string
  taskId: string
  pointerId: number
  startClientX: number
  startClientY: number
  startX: number
  startY: number
  maxX: number
  maxY: number
}

type DragState = DragProject | DragTask

type PendingProjectDrag = {
  id: string
  pointerId: number
  startClientX: number
  startClientY: number
  startX: number
  startY: number
}

type PendingTaskDrag = {
  projectId: string
  taskId: string
  pointerId: number
  startClientX: number
  startClientY: number
  startX: number
  startY: number
}

type ResizeState =
  | {
      kind: 'project'
      id: string
      edge: ResizeHandle
      pointerId: number
      start: RectStart
    }
  | {
      kind: 'task'
      projectId: string
      taskId: string
      edge: ResizeHandle
      pointerId: number
      start: RectStart
    }

/** One-slot undo for the last removed project note or task note. */
type DeleteUndoEntry =
  | { kind: 'project'; boardId: string; snapshot: ProjectNote; insertAt: number }
  | {
      kind: 'task'
      boardId: string
      projectId: string
      snapshot: TaskNote
      insertAt: number
    }

const DELETE_UNDO_MS = 8500

function deleteUndoMessage(entry: DeleteUndoEntry): string {
  if (entry.kind === 'project') {
    const raw = entry.snapshot.title.trim() || 'Untitled project'
    const t = raw.length > 42 ? `${raw.slice(0, 42)}…` : raw
    return `Project note deleted: ${t}`
  }
  const raw = entry.snapshot.title.trim() || 'Untitled task'
  const t = raw.length > 38 ? `${raw.slice(0, 38)}…` : raw
  return `Task note deleted: ${t}`
}

export function BoardApp() {
  const [workspace, setWorkspace] = useState<WorkspaceState | null>(null)
  const [taskEvents, setTaskEvents] = useState<TaskChangeEvent[]>([])
  const [drag, setDrag] = useState<DragState | null>(null)
  const [pendingProjectDrag, setPendingProjectDrag] =
    useState<PendingProjectDrag | null>(null)
  const [pendingTaskDrag, setPendingTaskDrag] = useState<PendingTaskDrag | null>(
    null,
  )
  const [editingTitleId, setEditingTitleId] = useState<string | null>(null)
  const [editingTaskTitleKey, setEditingTaskTitleKey] = useState<string | null>(
    null,
  )
  /** When null, task body shows linkified readonly view until focused for editing. */
  const [taskBodyFocusKey, setTaskBodyFocusKey] = useState<string | null>(null)
  const [resize, setResize] = useState<ResizeState | null>(null)
  const [zBoost, setZBoost] = useState<{ key: string; z: number }>({ key: '', z: 0 })
  const surfaceRef = useRef<HTMLDivElement>(null)
  const miniLayerRefs = useRef<Record<string, HTMLDivElement | null>>({})
  const titleInputRef = useRef<HTMLInputElement | null>(null)
  const taskTitleInputRef = useRef<HTMLInputElement | null>(null)
  const taskNoteBodyRefs = useRef<Record<string, HTMLDivElement | null>>({})
  const taskNotesReadonlyRefs = useRef<
    Record<string, HTMLDivElement | null>
  >({})
  const stateRef = useRef<BoardState | null>(null)
  const workspaceRef = useRef<WorkspaceState | null>(null)
  const headerTapRef = useRef<{ id: string; t: number } | null>(null)
  const taskHeaderTapRef = useRef<{ key: string; t: number } | null>(null)
  const zSeq = useRef(0)
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const saveEventsTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const prevStateForEvents = useRef<BoardState | null>(null)
  const [editingBoardTitleId, setEditingBoardTitleId] = useState<string | null>(null)
  const boardTabTitleInputRef = useRef<HTMLInputElement | null>(null)
  const [reportBusy, setReportBusy] = useState(false)
  const [reportNotice, setReportNotice] = useState<string | null>(null)
  const reportNoticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const bumpZ = useCallback((key: string) => {
    zSeq.current += 1
    setZBoost({ key, z: zSeq.current })
  }, [])

  const [deleteUndo, setDeleteUndo] = useState<DeleteUndoEntry | null>(null)
  const deleteUndoTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const activeBoard = useMemo(
    () =>
      workspace?.boards?.find((b) => b.id === workspace.activeBoardId) ?? null,
    [workspace],
  )
  const state = useMemo((): BoardState | null => {
    if (!activeBoard) return null
    return { theme: activeBoard.theme, projects: activeBoard.projects }
  }, [activeBoard])

  /** Reflow readonly note sizing when text or wrap-affecting widths change (not every drag). */
  const miniNotesReadonlyLayoutKey = useMemo(() => {
    if (!state) return ''
    return state.projects
      .map((p) =>
        [
          p.id,
          p.width,
          p.tasks.map((t) => [t.id, t.text, t.width].join('\x1e')).join('\x1f'),
        ].join('\x1d'),
      )
      .join('\x1c')
  }, [state])

  const clearDeleteUndoTimer = useCallback(() => {
    if (deleteUndoTimerRef.current) {
      clearTimeout(deleteUndoTimerRef.current)
      deleteUndoTimerRef.current = null
    }
  }, [])

  const showReportNotice = useCallback((msg: string) => {
    setReportNotice(msg)
    if (reportNoticeTimer.current) clearTimeout(reportNoticeTimer.current)
    reportNoticeTimer.current = setTimeout(() => {
      reportNoticeTimer.current = null
      setReportNotice(null)
    }, REPORT_NOTICE_MS)
  }, [])

  const pushDeleteUndo = useCallback(
    (entry: DeleteUndoEntry) => {
      setDeleteUndo(entry)
      clearDeleteUndoTimer()
      deleteUndoTimerRef.current = setTimeout(() => {
        deleteUndoTimerRef.current = null
        setDeleteUndo(null)
      }, DELETE_UNDO_MS)
    },
    [clearDeleteUndoTimer],
  )

  const undoLastDelete = useCallback(() => {
    setDeleteUndo((entry) => {
      if (!entry) return null
      clearDeleteUndoTimer()
      if (entry.kind === 'project') bumpZ(`p:${entry.snapshot.id}`)
      else bumpZ(`t:${entry.projectId}:${entry.snapshot.id}`)
      setWorkspace((ws) => {
        if (!ws) return ws
        const bi = ws.boards.findIndex((b) => b.id === entry.boardId)
        if (bi < 0) return ws
        const b = ws.boards[bi]
        if (entry.kind === 'project') {
          const projects = [...b.projects]
          const at = Math.min(entry.insertAt, projects.length)
          projects.splice(at, 0, entry.snapshot)
          const boards = ws.boards.slice()
          boards[bi] = { ...b, projects }
          return { ...ws, boards }
        }
        const projects = b.projects.map((p) => {
          if (p.id !== entry.projectId) return p
          const tasks = [...p.tasks]
          const at = Math.min(entry.insertAt, tasks.length)
          tasks.splice(at, 0, entry.snapshot)
          return { ...p, tasks }
        })
        const boards = ws.boards.slice()
        boards[bi] = { ...b, projects }
        return { ...ws, boards }
      })
      return null
    })
  }, [bumpZ, clearDeleteUndoTimer])

  const setBoard = useCallback((updater: (prev: BoardState) => BoardState | null) => {
    setWorkspace((ws) => {
      if (!ws) return ws
      const idx = ws.boards.findIndex((x) => x.id === ws.activeBoardId)
      if (idx < 0) return ws
      const cur: BoardState = {
        theme: ws.boards[idx].theme,
        projects: ws.boards[idx].projects,
      }
      const next = updater(cur)
      if (!next) return ws
      const boards = ws.boards.slice()
      boards[idx] = { ...boards[idx], theme: next.theme, projects: next.projects }
      return { ...ws, boards }
    })
  }, [])

  useEffect(() => {
    return () => clearDeleteUndoTimer()
  }, [clearDeleteUndoTimer])

  useEffect(() => {
    return () => {
      if (reportNoticeTimer.current) clearTimeout(reportNoticeTimer.current)
    }
  }, [])

  useEffect(() => {
    if (!deleteUndo) return
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.key !== 'z' || e.shiftKey) return
      const el = e.target
      if (
        el instanceof HTMLInputElement ||
        el instanceof HTMLTextAreaElement ||
        (el instanceof HTMLElement && el.isContentEditable)
      ) {
        return
      }
      e.preventDefault()
      undoLastDelete()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [deleteUndo, undoLastDelete])

  const fitMiniTaskFromNoteBody = useCallback(
    (projectId: string, taskId: string, el: HTMLElement) => {
      el.style.overflowY = 'hidden'
      el.style.height = 'auto'
      const contentH = el.scrollHeight
      el.style.height = `${Math.max(52, contentH)}px`
      let fitH = MINI_HEADER_APPROX + MINI_BODY_PAD_V + contentH
      fitH = clamp(fitH, MINI_MIN_H, MINI_MAX_H)
      const extraW =
        el.scrollWidth > el.clientWidth + 2
          ? el.scrollWidth - el.clientWidth + MINI_BODY_PAD_H
          : 0
      setBoard((prev) => {
        if (!prev) return prev
        return {
          ...prev,
          projects: prev.projects.map((p) => {
            if (p.id !== projectId) return p
            const t = p.tasks.find((x) => x.id === taskId)
            if (!t) return p

            let width = t.width
            if (extraW > 0) {
              width = clamp(
                t.width + extraW,
                MINI_MIN_W,
                Math.min(MINI_MAX_W, p.width - 20 - t.x),
              )
            }
            if (fitH === t.height && width === t.width) return p

            let newTask: TaskNote = { ...t, height: fitH, width }
            let newP: ProjectNote = {
              ...p,
              tasks: p.tasks.map((tt) => (tt.id === taskId ? newTask : tt)),
            }
            newP = expandProjectToFitAllTasks(newP)

            if (extraW > 0) {
              const maxTW = Math.min(MINI_MAX_W, newP.width - 20 - t.x)
              const w2 = clamp(t.width + extraW, MINI_MIN_W, maxTW)
              if (w2 !== newTask.width) {
                newTask = { ...newTask, width: w2 }
                newP = {
                  ...newP,
                  tasks: newP.tasks.map((tt) =>
                    tt.id === taskId ? newTask : tt,
                  ),
                }
                newP = expandProjectToFitAllTasks(newP)
              }
            }

            return newP
          }),
        }
      })
    },
    [setBoard],
  )

  useLayoutEffect(() => {
    if (!state) return
    setBoard((prev) => {
      if (!prev) return prev
      let changed = false
      const projects = prev.projects.map((p) => {
        const tasks = p.tasks.map((t) => {
          const tKey = taskEditKey(p.id, t.id)
          if (taskBodyFocusKey === tKey) return t
          const el = taskNotesReadonlyRefs.current[tKey]
          if (!el) return t
          const contentH = Math.max(52, el.scrollHeight)
          let fitH = MINI_HEADER_APPROX + MINI_BODY_PAD_V + contentH
          fitH = clamp(fitH, MINI_MIN_H, MINI_MAX_H)
          const extraW =
            el.scrollWidth > el.clientWidth + 2
              ? el.scrollWidth - el.clientWidth + MINI_BODY_PAD_H
              : 0
          let width = t.width
          if (extraW > 0) {
            width = clamp(
              t.width + extraW,
              MINI_MIN_W,
              Math.min(MINI_MAX_W, p.width - 20 - t.x),
            )
          }
          if (fitH === t.height && width === t.width) return t
          return { ...t, height: fitH, width }
        })

        let newP = expandProjectToFitAllTasks({ ...p, tasks })
        const taskGeomsChanged = tasks.some((t, i) => {
          const u = p.tasks[i]
          return (
            t !== u &&
            (t.height !== u.height || t.width !== u.width)
          )
        })
        const projectDimsChanged =
          newP.width !== p.width ||
          newP.height !== p.height ||
          newP.x !== p.x ||
          newP.y !== p.y

        if (!taskGeomsChanged && !projectDimsChanged) return p

        changed = true
        return newP
      })
      return changed ? { ...prev, projects } : prev
    })
  }, [miniNotesReadonlyLayoutKey, taskBodyFocusKey, setBoard])

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      const fromDisk = await loadWorkspaceFromDisk()
      if (cancelled) return
      const eventsFromDisk = await loadTaskEventsFromDisk()
      if (cancelled) return
      const fromLocal = loadWorkspaceFromLocal()
      const eventsFromLocal = loadTaskEventsFromLocal()
      const raw = fromDisk ?? fromLocal ?? defaultWorkspace()
      const hydrated = normalizeWorkspace(raw)
      setTaskEvents(eventsFromDisk ?? eventsFromLocal)
      prevStateForEvents.current = flattenWorkspaceForEvents(hydrated)
      setWorkspace(hydrated)
    })()
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    if (!workspace) return
    if (saveTimer.current) clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(() => {
      saveWorkspaceToLocal(workspace)
      void saveWorkspaceToDisk(workspace)
    }, SAVE_MS)
    return () => {
      if (saveTimer.current) clearTimeout(saveTimer.current)
    }
  }, [workspace])

  useEffect(() => {
    if (!workspace) return
    const flat = flattenWorkspaceForEvents(workspace)
    const prev = prevStateForEvents.current
    if (!prev) {
      prevStateForEvents.current = flat
      return
    }
    const at = new Date().toISOString()
    const incoming = collectTaskEvents(prev, flat, at)
    if (incoming.length > 0) {
      setTaskEvents((existing) => mergeTaskEvents(existing, incoming))
    }
    prevStateForEvents.current = flat
  }, [workspace])

  useEffect(() => {
    setTaskBodyFocusKey(null)
  }, [workspace?.activeBoardId])

  useEffect(() => {
    if (saveEventsTimer.current) clearTimeout(saveEventsTimer.current)
    saveEventsTimer.current = setTimeout(() => {
      saveTaskEventsToLocal(taskEvents)
      void saveTaskEventsToDisk(taskEvents)
    }, SAVE_MS)
    return () => {
      if (saveEventsTimer.current) clearTimeout(saveEventsTimer.current)
    }
  }, [taskEvents])

  useLayoutEffect(() => {
    if (!editingTitleId) return
    const el = titleInputRef.current
    el?.focus()
    el?.select()
  }, [editingTitleId])

  useLayoutEffect(() => {
    if (!editingTaskTitleKey) return
    const el = taskTitleInputRef.current
    el?.focus()
    el?.select()
  }, [editingTaskTitleKey])

  useLayoutEffect(() => {
    if (!editingBoardTitleId) return
    const el = boardTabTitleInputRef.current
    el?.focus()
    el?.select()
  }, [editingBoardTitleId])

  const didInitialMiniFit = useRef(false)
  useLayoutEffect(() => {
    if (!state) {
      didInitialMiniFit.current = false
      return
    }
    if (didInitialMiniFit.current) return
    didInitialMiniFit.current = true
    requestAnimationFrame(() => {
      for (const p of state.projects) {
        for (const t of p.tasks) {
          const el = taskNoteBodyRefs.current[taskEditKey(p.id, t.id)]
          if (el) fitMiniTaskFromNoteBody(p.id, t.id, el)
        }
      }
    })
  }, [state, fitMiniTaskFromNoteBody])

  useLayoutEffect(() => {
    if (!drag && !pendingProjectDrag && !pendingTaskDrag && !resize) return

    const onMove = (e: PointerEvent) => {
      if (resize && e.pointerId === resize.pointerId) {
        const sx = e.clientX
        const sy = e.clientY
        setBoard((prev) => {
          if (!prev) return prev
          if (resize.kind === 'project') {
            const b = {
              minW: PROJECT_MIN_W,
              maxW: PROJECT_MAX_W,
              minH: PROJECT_MIN_H,
              maxH: PROJECT_MAX_H,
              spanX: BOARD_W,
              spanY: BOARD_H,
            }
            const r = isResizeCorner(resize.edge)
              ? applyCornerResize(resize.edge, resize.start, sx, sy, b)
              : applyEdgeResize(resize.edge, resize.start, sx, sy, b)
            return {
              ...prev,
              projects: prev.projects.map((p) =>
                p.id === resize.id
                  ? { ...p, x: r.x, y: r.y, width: r.w, height: r.h }
                  : p,
              ),
            }
          }
          if (resize.kind === 'task') {
            const proj = prev.projects.find((p) => p.id === resize.projectId)
            if (!proj) return prev
            const layer = miniLayerRefs.current[resize.projectId]
            const lw = layer?.clientWidth ?? proj.width - 20
            const lh =
              layer?.clientHeight ?? estimatedMiniLayerHeight(proj)
            const b = {
              minW: MINI_MIN_W,
              maxW: MINI_MAX_W,
              minH: MINI_MIN_H,
              maxH: MINI_MAX_H,
              spanX: lw,
              spanY: lh,
            }
            const r = isResizeCorner(resize.edge)
              ? applyCornerResize(resize.edge, resize.start, sx, sy, b)
              : applyEdgeResize(resize.edge, resize.start, sx, sy, b)
            return {
              ...prev,
              projects: prev.projects.map((p) =>
                p.id !== resize.projectId
                  ? p
                  : {
                      ...p,
                      tasks: p.tasks.map((t) =>
                        t.id !== resize.taskId
                          ? t
                          : { ...t, x: r.x, y: r.y, width: r.w, height: r.h },
                      ),
                    },
              ),
            }
          }
          return prev
        })
        return
      }

      if (pendingProjectDrag && e.pointerId === pendingProjectDrag.pointerId) {
        const dx = e.clientX - pendingProjectDrag.startClientX
        const dy = e.clientY - pendingProjectDrag.startClientY
        if (dx * dx + dy * dy >= DRAG_THRESHOLD_SQ) {
          bumpZ(`p:${pendingProjectDrag.id}`)
          setDrag({
            kind: 'project',
            id: pendingProjectDrag.id,
            pointerId: pendingProjectDrag.pointerId,
            startClientX: pendingProjectDrag.startClientX,
            startClientY: pendingProjectDrag.startClientY,
            startX: pendingProjectDrag.startX,
            startY: pendingProjectDrag.startY,
          })
          setPendingProjectDrag(null)
          headerTapRef.current = null
        }
        return
      }

      if (pendingTaskDrag && e.pointerId === pendingTaskDrag.pointerId) {
        const dx = e.clientX - pendingTaskDrag.startClientX
        const dy = e.clientY - pendingTaskDrag.startClientY
        if (dx * dx + dy * dy >= DRAG_THRESHOLD_SQ) {
          const layer = miniLayerRefs.current[pendingTaskDrag.projectId]
          const s = stateRef.current
          const proj = s?.projects.find((x) => x.id === pendingTaskDrag.projectId)
          const tk = proj?.tasks.find((x) => x.id === pendingTaskDrag.taskId)
          const tw = tk?.width ?? DEF_MINI_W
          const th = tk?.height ?? DEF_MINI_H
          const lw = layer?.clientWidth ?? (proj?.width ?? DEF_PROJECT_W) - 20
          const lh =
            layer?.clientHeight ??
            (proj ? estimatedMiniLayerHeight(proj) : DEF_PROJECT_H - 120)
          bumpZ(`t:${pendingTaskDrag.projectId}:${pendingTaskDrag.taskId}`)
          setDrag({
            kind: 'task',
            projectId: pendingTaskDrag.projectId,
            taskId: pendingTaskDrag.taskId,
            pointerId: pendingTaskDrag.pointerId,
            startClientX: pendingTaskDrag.startClientX,
            startClientY: pendingTaskDrag.startClientY,
            startX: pendingTaskDrag.startX,
            startY: pendingTaskDrag.startY,
            maxX: Math.max(0, lw - tw),
            maxY: Math.max(0, lh - th),
          })
          setPendingTaskDrag(null)
          taskHeaderTapRef.current = null
        }
        return
      }

      if (!drag || e.pointerId !== drag.pointerId) return
      const dx = e.clientX - drag.startClientX
      const dy = e.clientY - drag.startClientY

      if (drag.kind === 'project') {
        setBoard((prev) => {
          if (!prev) return prev
          const p = prev.projects.find((x) => x.id === drag.id)
          if (!p) return prev
          const pw = p.width
          const ph = p.height
          const x = clamp(drag.startX + dx, 0, BOARD_W - pw)
          const y = clamp(drag.startY + dy, 0, BOARD_H - ph)
          return {
            ...prev,
            projects: prev.projects.map((q) =>
              q.id === drag.id ? { ...q, x, y } : q,
            ),
          }
        })
        return
      }

      const x = clamp(drag.startX + dx, 0, drag.maxX)
      const y = clamp(drag.startY + dy, 0, drag.maxY)
      setBoard((prev) => {
        if (!prev) return prev
        return {
          ...prev,
          projects: prev.projects.map((p) => {
            if (p.id !== drag.projectId) return p
            return {
              ...p,
              tasks: p.tasks.map((t) =>
                t.id === drag.taskId ? { ...t, x, y } : t,
              ),
            }
          }),
        }
      })
    }

    const onUp = (e: PointerEvent) => {
      if (resize && e.pointerId === resize.pointerId) {
        setResize(null)
        return
      }
      if (pendingProjectDrag && e.pointerId === pendingProjectDrag.pointerId) {
        const now = Date.now()
        const prev = headerTapRef.current
        if (
          prev &&
          prev.id === pendingProjectDrag.id &&
          now - prev.t < HEADER_DOUBLE_TAP_MS
        ) {
          headerTapRef.current = null
          setEditingTitleId(pendingProjectDrag.id)
        } else {
          headerTapRef.current = {
            id: pendingProjectDrag.id,
            t: now,
          }
        }
        setPendingProjectDrag(null)
        return
      }
      if (pendingTaskDrag && e.pointerId === pendingTaskDrag.pointerId) {
        const key = taskEditKey(pendingTaskDrag.projectId, pendingTaskDrag.taskId)
        const now = Date.now()
        const prev = taskHeaderTapRef.current
        if (
          prev &&
          prev.key === key &&
          now - prev.t < HEADER_DOUBLE_TAP_MS
        ) {
          taskHeaderTapRef.current = null
          setEditingTaskTitleKey(key)
        } else {
          taskHeaderTapRef.current = { key, t: now }
        }
        setPendingTaskDrag(null)
        return
      }
      if (drag && e.pointerId === drag.pointerId) {
        setDrag(null)
      }
    }

    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
    }
  }, [drag, pendingProjectDrag, pendingTaskDrag, resize, bumpZ])

  const setTheme = (theme: BoardTheme) => {
    setBoard((s) => (s ? { ...s, theme } : s))
  }

  const updateBoardTitle = useCallback((boardId: string, title: string) => {
    setWorkspace((ws) => {
      if (!ws) return ws
      const boards = ws.boards.map((b) => (b.id === boardId ? { ...b, title } : b))
      return { ...ws, boards }
    })
  }, [])

  const switchBoard = useCallback((id: string) => {
    setEditingBoardTitleId(null)
    setTaskBodyFocusKey(null)
    setDrag(null)
    setPendingProjectDrag(null)
    setPendingTaskDrag(null)
    setResize(null)
    setWorkspace((ws) => (ws ? { ...ws, activeBoardId: id } : ws))
  }, [])

  const addBoard = useCallback(() => {
    const id = newId()
    setWorkspace((ws) => {
      if (!ws) return ws
      return {
        boards: [
          ...ws.boards,
          {
            id,
            title: 'New board',
            theme: 'blackboard',
            projects: [],
          },
        ],
        activeBoardId: id,
      }
    })
  }, [])

  const moveProjectToBoard = useCallback((projectId: string, targetBoardId: string) => {
    setWorkspace((ws) => {
      if (!ws) return ws
      let extracted: ProjectNote | undefined
      for (const b of ws.boards) {
        const idx = b.projects.findIndex((p) => p.id === projectId)
        if (idx >= 0) {
          extracted = b.projects[idx]
          break
        }
      }
      if (!extracted) return ws
      const without = ws.boards.map((b) => ({
        ...b,
        projects: b.projects.filter((p) => p.id !== projectId),
      }))
      const target = without.find((b) => b.id === targetBoardId)
      if (!target) return ws
      const pos =
        findFreeProjectPosition(target.projects, extracted.width, extracted.height) ?? {
          x: 120,
          y: 100,
        }
      const placed: ProjectNote = {
        ...extracted,
        x: clamp(pos.x, 0, BOARD_W - extracted.width),
        y: clamp(pos.y, 0, BOARD_H - extracted.height),
      }
      return {
        ...ws,
        boards: without.map((b) =>
          b.id === targetBoardId ? { ...b, projects: [...b.projects, placed] } : b,
        ),
      }
    })
  }, [])

  const createWeeklyReport = async () => {
    if (reportBusy) return
    setReportBusy(true)
    try {
      const now = new Date()
      const start = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000)
      const weekLabel = `${start.toLocaleDateString()} - ${now.toLocaleDateString()}`
      // Step 1: temporary weekly diff artifact.
      const diffText = buildWeeklyDiffText(taskEvents, now)
      const stamp = now.toISOString().slice(0, 10)
      const result = await createWeeklyReportOnDisk({
        diffText,
        weekLabel,
        suggestedFilename: `weekly-report-${stamp}.md`,
      })
      if (result?.path) {
        showReportNotice(`Weekly report created (AI summarized): ${result.path}`)
      }
      else showReportNotice(result?.error || 'Could not write weekly report file.')
    } finally {
      setReportBusy(false)
    }
  }

  const addProject = () => {
    setBoard((s) => {
      if (!s) return s
      const hues = s.projects.map((p) => p.hue)
      const pos = findFreeProjectPosition(s.projects, DEF_PROJECT_W, DEF_PROJECT_H)
      return {
        ...s,
        projects: [
          ...s.projects,
          {
            id: newId(),
            title: 'New workstream',
            createdAt: new Date().toISOString(),
            hue: pickDistinctHue(hues),
            x: clamp(pos.x, 0, BOARD_W - DEF_PROJECT_W),
            y: clamp(pos.y, 0, BOARD_H - DEF_PROJECT_H),
            width: DEF_PROJECT_W,
            height: DEF_PROJECT_H,
            tasks: [],
          },
        ],
      }
    })
  }

  const removeProject = (id: string) => {
    const boardId = workspaceRef.current?.activeBoardId
    if (!boardId) return
    let undo: DeleteUndoEntry | null = null
    flushSync(() => {
      setBoard((prev) => {
        if (!prev) return prev
        const idx = prev.projects.findIndex((p) => p.id === id)
        if (idx < 0) return prev
        undo = {
          kind: 'project',
          boardId,
          snapshot: {
            ...prev.projects[idx],
            tasks: prev.projects[idx].tasks.map((t) => ({ ...t })),
          },
          insertAt: idx,
        }
        return {
          ...prev,
          projects: prev.projects.filter((p) => p.id !== id),
        }
      })
    })
    if (undo) pushDeleteUndo(undo)
    setEditingTitleId((cur) => (cur === id ? null : cur))
    const prefix = `${id}:`
    setEditingTaskTitleKey((cur) => (cur?.startsWith(prefix) ? null : cur))
  }

  const updateTitle = (id: string, title: string) => {
    setBoard((s) =>
      s
        ? {
            ...s,
            projects: s.projects.map((p) =>
              p.id === id ? { ...p, title } : p,
            ),
          }
        : s,
    )
  }

  const addTask = (projectId: string) => {
    const taskId = newId()
    const tKey = taskEditKey(projectId, taskId)
    flushSync(() => {
      setBoard((s) => {
        if (!s) return s
        const tw = DEF_MINI_W
        const th = DEF_MINI_H
        const margin = 6
        return {
          ...s,
          projects: s.projects.map((p) => {
            if (p.id !== projectId) return p
            const maxW = Math.min(PROJECT_MAX_W, BOARD_W - p.x)
            const maxH = Math.min(PROJECT_MAX_H, BOARD_H - p.y)
            let width = p.width
            let height = p.height
            let slot = findFreeTaskPosition({ ...p, width, height }, tw, th, margin)
            let guard = 0
            while (!slot && guard < 250) {
              guard += 1
              if (height < maxH) {
                height = Math.min(maxH, height + 32)
              } else if (width < maxW) {
                width = Math.min(maxW, width + 40)
              } else {
                break
              }
              slot = findFreeTaskPosition({ ...p, width, height }, tw, th, margin)
            }
            if (!slot) {
              const W = miniLayerInnerWidth({ ...p, width, height })
              const H = estimatedMiniLayerHeight({ ...p, width, height })
              slot = {
                x: clamp(12, 0, Math.max(0, W - tw)),
                y: clamp(8, 0, Math.max(0, H - th)),
              }
            }
            return {
              ...p,
              width,
              height,
              tasks: [
                ...p.tasks,
                {
                  id: taskId,
                  title: '',
                  text: '',
                  createdAt: new Date().toISOString(),
                  x: slot.x,
                  y: slot.y,
                  width: tw,
                  height: th,
                },
              ],
            }
          }),
        }
      })
    })
    setTaskBodyFocusKey(tKey)
    requestAnimationFrame(() => {
      taskNoteBodyRefs.current[tKey]?.focus({ preventScroll: true })
    })
  }

  const updateTaskTitle = (
    projectId: string,
    taskId: string,
    title: string,
  ) => {
    setBoard((s) => {
      if (!s) return s
      return {
        ...s,
        projects: s.projects.map((p) => {
          if (p.id !== projectId) return p
          return {
            ...p,
            tasks: p.tasks.map((t) =>
              t.id === taskId ? { ...t, title } : t,
            ),
          }
        }),
      }
    })
  }

  const updateTaskText = (
    projectId: string,
    taskId: string,
    text: string,
  ) => {
    setBoard((s) => {
      if (!s) return s
      return {
        ...s,
        projects: s.projects.map((p) => {
          if (p.id !== projectId) return p
          return {
            ...p,
            tasks: p.tasks.map((t) =>
              t.id === taskId ? { ...t, text } : t,
            ),
          }
        }),
      }
    })
  }

  const removeTask = (projectId: string, taskId: string) => {
    const boardId = workspaceRef.current?.activeBoardId
    if (!boardId) return
    let undo: DeleteUndoEntry | null = null
    flushSync(() => {
      setBoard((prev) => {
        if (!prev) return prev
        const p = prev.projects.find((pr) => pr.id === projectId)
        if (!p) return prev
        const tidx = p.tasks.findIndex((t) => t.id === taskId)
        if (tidx < 0) return prev
        undo = {
          kind: 'task',
          boardId,
          projectId,
          snapshot: { ...p.tasks[tidx] },
          insertAt: tidx,
        }
        return {
          ...prev,
          projects: prev.projects.map((pr) =>
            pr.id !== projectId
              ? pr
              : { ...pr, tasks: pr.tasks.filter((t) => t.id !== taskId) },
          ),
        }
      })
    })
    if (undo) pushDeleteUndo(undo)
    const k = taskEditKey(projectId, taskId)
    setEditingTaskTitleKey((cur) => (cur === k ? null : cur))
    setTaskBodyFocusKey((cur) => (cur === k ? null : cur))
  }

  const onProjectResizePointerDown = (
    e: React.PointerEvent,
    project: ProjectNote,
    edge: ResizeHandle,
  ) => {
    if (e.button !== 0) return
    e.stopPropagation()
    e.preventDefault()
    bumpZ(`p:${project.id}`)
    setResize({
      kind: 'project',
      id: project.id,
      edge,
      pointerId: e.pointerId,
      start: {
        x: project.x,
        y: project.y,
        w: project.width,
        h: project.height,
        clientX: e.clientX,
        clientY: e.clientY,
      },
    })
  }

  const onTaskResizePointerDown = (
    e: React.PointerEvent,
    project: ProjectNote,
    task: TaskNote,
    edge: ResizeHandle,
  ) => {
    if (e.button !== 0) return
    e.stopPropagation()
    e.preventDefault()
    bumpZ(`t:${project.id}:${task.id}`)
    setResize({
      kind: 'task',
      projectId: project.id,
      taskId: task.id,
      edge,
      pointerId: e.pointerId,
      start: {
        x: task.x,
        y: task.y,
        w: task.width,
        h: task.height,
        clientX: e.clientX,
        clientY: e.clientY,
      },
    })
  }

  /** Bring project to front (capture) without stealing mini-note interactions. */
  const onProjectStickyPointerDownCapture = (
    e: React.PointerEvent,
    project: ProjectNote,
  ) => {
    if (e.button !== 0) return
    const el = e.target as HTMLElement
    if (
      el.closest('.mini-body') &&
      (el.closest('.mini-text--editable') ||
        (e.target instanceof HTMLElement && e.target.isContentEditable))
    ) {
      return
    }
    /* Clicks inside .mini-body are handled there (focus / switch task). Do not
       setTaskBodyFocusKey(null) here — it batches with that handler's flushSync
       and can win the race, leaving notes stuck in readonly (e.g. new tasks). */
    if (el.closest('.mini-body')) {
      return
    }

    setTaskBodyFocusKey(null)

    if (el.closest('.mini-sticky')) return
    if (el.closest('[data-resize-handle]')) return
    if (el.closest('button')) return
    if (el.closest('select')) return
    bumpZ(`p:${project.id}`)
  }

  const beginPendingProjectDrag = (
    e: React.PointerEvent,
    project: ProjectNote,
  ) => {
    if (e.button !== 0) return
    if (editingTitleId === project.id) return
    const el = e.target as HTMLElement
    if (el.closest('[data-resize-handle]')) return
    if (el.closest('button')) return
    if (el.closest('select')) return
    if (el.closest('.mini-sticky')) return
    setPendingProjectDrag({
      id: project.id,
      pointerId: e.pointerId,
      startClientX: e.clientX,
      startClientY: e.clientY,
      startX: project.x,
      startY: project.y,
    })
    e.preventDefault()
  }

  const beginPendingTaskDrag = (
    e: React.PointerEvent,
    project: ProjectNote,
    task: TaskNote,
  ) => {
    if (e.button !== 0) return
    if (editingTaskTitleKey === taskEditKey(project.id, task.id)) return
    const el = e.target as HTMLElement
    if (el.closest('button')) return
    if (el.closest('[data-resize-handle]')) return
    if (el.closest('.mini-text--editable')) return
    setPendingTaskDrag({
      projectId: project.id,
      taskId: task.id,
      pointerId: e.pointerId,
      startClientX: e.clientX,
      startClientY: e.clientY,
      startX: task.x,
      startY: task.y,
    })
    e.preventDefault()
  }

  const zForProject = (id: string) =>
    10 + (zBoost.key === `p:${id}` ? zBoost.z : 0)

  const zForTask = (projectId: string, taskId: string) =>
    20 + (zBoost.key === `t:${projectId}:${taskId}` ? zBoost.z : 0)

  workspaceRef.current = workspace
  stateRef.current = state

  if (!state || !workspace) {
    return (
      <div className="board-app board-app--loading" data-theme="blackboard">
        <div className="board-loading">Loading board…</div>
      </div>
    )
  }

  return (
    <div className="board-app" data-theme={state.theme}>
      <header className="board-toolbar">
        <div className="board-toolbar-boards" role="tablist" aria-label="Boards">
          {workspace.boards.map((b) => (
            <div
              key={b.id}
              className="board-tab-wrap board-tab-wrap--colored"
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
                  title="Double-click to rename"
                  onClick={() => switchBoard(b.id)}
                  onDoubleClick={(e) => {
                    e.preventDefault()
                    setEditingBoardTitleId(b.id)
                  }}
                >
                  {b.title.trim() || 'Untitled board'}
                </button>
              )}
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
        <div className="segmented" role="group" aria-label="Surface style">
          <button
            type="button"
            aria-pressed={state.theme === 'whiteboard'}
            onClick={() => setTheme('whiteboard')}
          >
            Whiteboard
          </button>
          <button
            type="button"
            aria-pressed={state.theme === 'blackboard'}
            onClick={() => setTheme('blackboard')}
          >
            Blackboard
          </button>
        </div>
        <span className="spacer" />
        <button
          type="button"
          className="btn btn-ghost"
          onClick={createWeeklyReport}
          disabled={reportBusy}
          title="Create a weekly markdown summary from task changes."
        >
          {reportBusy ? 'Generating…' : 'Weekly Report'}
        </button>
        <button type="button" className="btn btn-primary" onClick={addProject}>
          New project note
        </button>
      </header>
      {reportNotice ? (
        <div className="report-toast" role="status" aria-live="polite" aria-atomic="true">
          {reportNotice}
        </div>
      ) : null}
      {deleteUndo ? (
        <div
          className="delete-undo-toast"
          role="status"
          aria-live="polite"
          aria-atomic="true"
        >
          <span className="delete-undo-toast__msg">
            {deleteUndoMessage(deleteUndo)}
          </span>
          <button
            type="button"
            className="btn btn-primary delete-undo-toast__undo"
            title="When focus is not in a text field, ⌘Z or Ctrl+Z also undoes."
            onClick={undoLastDelete}
          >
            Undo
          </button>
          <button
            type="button"
            className="icon-btn delete-undo-toast__dismiss"
            aria-label="Dismiss"
            onClick={() => {
              clearDeleteUndoTimer()
              setDeleteUndo(null)
            }}
          >
            ×
          </button>
        </div>
      ) : null}
      <div className="board-viewport">
        <div
          ref={surfaceRef}
          className="board-surface"
          style={{ width: BOARD_W, height: BOARD_H }}
          onPointerDown={(e) => {
            if (e.button !== 0) return
            if (e.target === e.currentTarget) {
              setTaskBodyFocusKey(null)
            }
          }}
        >
          {state.projects.map((p) => {
            const pal = projectPalette(p.hue)
            const projectCreatedLabel = formatCreatedLabel(p.createdAt)
            return (
            <div
              key={p.id}
              className="project-sticky"
              style={{
                left: p.x,
                top: p.y,
                width: p.width,
                height: p.height,
                zIndex: zForProject(p.id),
                background: pal.gradient,
                color: pal.ink,
              }}
              onPointerDownCapture={(e) =>
                onProjectStickyPointerDownCapture(e, p)
              }
            >
              <div
                className={
                  editingTitleId === p.id
                    ? 'project-header project-header--editing'
                    : 'project-header'
                }
                style={{ borderBottomColor: pal.headerBorder }}
                onPointerDown={(e) => beginPendingProjectDrag(e, p)}
              >
                <div className="project-header-stack">
                  {editingTitleId === p.id ? (
                    <input
                      ref={titleInputRef}
                      className="project-title-input"
                      value={p.title}
                      onChange={(e) => updateTitle(p.id, e.target.value)}
                      placeholder="Project name"
                      aria-label="Project title"
                      onPointerDown={(e) => e.stopPropagation()}
                      onBlur={() => setEditingTitleId(null)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          e.preventDefault()
                          ;(e.target as HTMLInputElement).blur()
                        }
                        if (e.key === 'Escape') {
                          e.preventDefault()
                          setEditingTitleId(null)
                        }
                      }}
                    />
                  ) : (
                    <div
                      className="project-title-readonly"
                      title="Double-tap header to rename"
                      aria-label="Project title. Double-tap header to rename."
                    >
                      {p.title.trim() ? p.title : 'Untitled project'}
                    </div>
                  )}
                  {projectCreatedLabel ? (
                    <time
                      className="note-created-at"
                      dateTime={p.createdAt}
                      aria-label={`Created ${projectCreatedLabel}`}
                    >
                      {projectCreatedLabel}
                    </time>
                  ) : null}
                </div>
                <div className="project-actions">
                  {workspace.boards.length > 1 ? (
                    <select
                      className="board-move-select"
                      aria-label="Move project to another board"
                      value=""
                      onPointerDown={(e) => e.stopPropagation()}
                      onChange={(e) => {
                        const v = e.target.value
                        e.currentTarget.selectedIndex = 0
                        if (v) moveProjectToBoard(p.id, v)
                      }}
                    >
                      <option value="">Move to…</option>
                      {workspace.boards
                        .filter((b) => b.id !== workspace.activeBoardId)
                        .map((b) => (
                          <option key={b.id} value={b.id}>
                            {b.title.trim() || 'Untitled board'}
                          </option>
                        ))}
                    </select>
                  ) : null}
                  <button
                    type="button"
                    className="icon-btn danger"
                    title="Remove project"
                    onPointerDown={(e) => e.stopPropagation()}
                    onClick={() => removeProject(p.id)}
                  >
                    ×
                  </button>
                </div>
              </div>
              <div
                className="project-body"
                onPointerDown={(e) => beginPendingProjectDrag(e, p)}
              >
                <div className="add-mini-row">
                  <button
                    type="button"
                    className="add-mini"
                    onClick={() => addTask(p.id)}
                  >
                    + Add task note
                  </button>
                </div>
                <div
                  className="mini-layer"
                  ref={(el) => {
                    miniLayerRefs.current[p.id] = el
                  }}
                >
                  {p.tasks.map((t) => {
                    const mp = miniPalette(p.hue, t.id)
                    const tKey = taskEditKey(p.id, t.id)
                    const isEditingTaskTitle = editingTaskTitleKey === tKey
                    const taskCreatedLabel = formatCreatedLabel(t.createdAt)
                    return (
                    <div
                      key={t.id}
                      className="mini-sticky"
                      style={{
                        left: t.x,
                        top: t.y,
                        width: t.width,
                        height: t.height,
                        zIndex: zForTask(p.id, t.id),
                        background: mp.gradient,
                        color: mp.ink,
                      }}
                      onPointerDown={(e) => {
                        e.stopPropagation()
                        if (e.button !== 0) return
                        bumpZ(`t:${p.id}:${t.id}`)
                        const el = e.target as HTMLElement
                        if (el.closest('.mini-header')) return
                        if (el.closest('[data-resize-handle]')) return
                        if (el.closest('.mini-body')) return
                      }}
                    >
                      <div
                        className={
                          isEditingTaskTitle
                            ? 'mini-header mini-header--editing'
                            : 'mini-header'
                        }
                        style={{ borderBottomColor: mp.headerBorder }}
                        title="Double-tap header to edit title"
                        onPointerDown={(e) => {
                          if (e.button !== 0) return
                          bumpZ(`t:${p.id}:${t.id}`)
                          beginPendingTaskDrag(e, p, t)
                          e.stopPropagation()
                        }}
                      >
                        <div className="mini-header-stack">
                          {isEditingTaskTitle ? (
                            <input
                              ref={taskTitleInputRef}
                              className="mini-title-input"
                              value={t.title}
                              onChange={(e) =>
                                updateTaskTitle(p.id, t.id, e.target.value)
                              }
                              placeholder="Task title"
                              aria-label="Task title"
                              onPointerDown={(e) => e.stopPropagation()}
                              onBlur={() => setEditingTaskTitleKey(null)}
                              onKeyDown={(e) => {
                                if (e.key === 'Enter') {
                                  e.preventDefault()
                                  ;(e.target as HTMLInputElement).blur()
                                }
                                if (e.key === 'Escape') {
                                  e.preventDefault()
                                  setEditingTaskTitleKey(null)
                                }
                              }}
                            />
                          ) : (
                            <div
                              className="mini-title-readonly"
                              aria-label="Task title. Double-tap header to rename."
                            >
                              {t.title.trim() ? t.title : 'Untitled task'}
                            </div>
                          )}
                          {taskCreatedLabel ? (
                            <time
                              className="note-created-at"
                              dateTime={t.createdAt}
                              aria-label={`Created ${taskCreatedLabel}`}
                            >
                              {taskCreatedLabel}
                            </time>
                          ) : null}
                        </div>
                        <button
                          type="button"
                          className="icon-btn danger"
                          title="Remove task"
                          onPointerDown={(e) => e.stopPropagation()}
                          onClick={() => removeTask(p.id, t.id)}
                        >
                          ×
                        </button>
                      </div>
                      <div
                        className="mini-body"
                        onPointerDown={(e) => {
                          if (e.button !== 0) return
                          bumpZ(`t:${p.id}:${t.id}`)
                          if ((e.target as HTMLElement).closest('a')) return
                          if (
                            (e.target as HTMLElement).closest(
                              '.mini-text--editable',
                            )
                          ) {
                            e.stopPropagation()
                            return
                          }
                          e.stopPropagation()
                          flushSync(() => setTaskBodyFocusKey(tKey))
                          taskNoteBodyRefs.current[tKey]?.focus({
                            preventScroll: true,
                          })
                        }}
                      >
                        {taskBodyFocusKey === tKey ? (
                          <MiniNoteEditor
                            ref={(el) => {
                              taskNoteBodyRefs.current[tKey] = el
                            }}
                            value={t.text}
                            onChange={(v) => {
                              updateTaskText(p.id, t.id, v)
                              requestAnimationFrame(() => {
                                const el = taskNoteBodyRefs.current[tKey]
                                if (el) fitMiniTaskFromNoteBody(p.id, t.id, el)
                              })
                            }}
                            onFocus={(ev) => {
                              setTaskBodyFocusKey(tKey)
                              requestAnimationFrame(() =>
                                fitMiniTaskFromNoteBody(
                                  p.id,
                                  t.id,
                                  ev.currentTarget,
                                ),
                              )
                            }}
                            placeholder="Notes…"
                            aria-label="Task notes"
                          />
                        ) : (
                          <div
                            ref={(el) => {
                              if (el) taskNotesReadonlyRefs.current[tKey] = el
                              else delete taskNotesReadonlyRefs.current[tKey]
                            }}
                            role="textbox"
                            tabIndex={0}
                            aria-label="Task notes. Press Enter to edit."
                            aria-multiline="true"
                            className="mini-text mini-text--readonly"
                            onKeyDown={(e) => {
                              if (e.key === 'Enter' && !e.shiftKey) {
                                e.preventDefault()
                                flushSync(() => setTaskBodyFocusKey(tKey))
                                taskNoteBodyRefs.current[tKey]?.focus({
                                  preventScroll: true,
                                })
                              }
                            }}
                          >
                            {t.text.trim() ? (
                              linkifyTaskBodyText(t.text)
                            ) : (
                              <span className="mini-text-placeholder">Notes…</span>
                            )}
                          </div>
                        )}
                      </div>
                      {(['n', 'e', 's', 'w'] as const).map((edge) => (
                        <div
                          key={edge}
                          data-resize-handle
                          className={`resize-handle resize-handle--${edge}`}
                          onPointerDown={(e) =>
                            onTaskResizePointerDown(e, p, t, edge)
                          }
                        />
                      ))}
                      {(['nw', 'ne', 'sw', 'se'] as const).map((c) => (
                        <div
                          key={c}
                          data-resize-handle
                          className={`resize-handle resize-handle--${c}`}
                          onPointerDown={(e) =>
                            onTaskResizePointerDown(e, p, t, c)
                          }
                        />
                      ))}
                    </div>
                    )
                  })}
                </div>
              </div>
              {(['n', 'e', 's', 'w'] as const).map((edge) => (
                <div
                  key={edge}
                  data-resize-handle
                  className={`resize-handle resize-handle--${edge}`}
                  onPointerDown={(e) => onProjectResizePointerDown(e, p, edge)}
                />
              ))}
              {(['nw', 'ne', 'sw', 'se'] as const).map((c) => (
                <div
                  key={c}
                  data-resize-handle
                  className={`resize-handle resize-handle--${c}`}
                  onPointerDown={(e) => onProjectResizePointerDown(e, p, c)}
                />
              ))}
            </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
