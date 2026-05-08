import { newId } from './ids'
import type { BoardEntry, BoardState, WorkspaceState } from './types'
import { parseTaskEvents, type TaskChangeEvent } from './taskEvents'

const WORKSPACE_LOCAL_KEY = 'productivity-workspace-v1'
const LEGACY_BOARD_LOCAL_KEY = 'productivity-board-v1'
const DISK_API = '/__board-api/state'
const EVENTS_LOCAL_KEY = 'productivity-task-events-v1'
const EVENTS_DISK_API = '/__board-api/task-events'
const WEEKLY_REPORT_API = '/__board-api/weekly-report'
const WEEKLY_REPORT_CLIENT_TIMEOUT_MS = 60_000

export function parseBoardState(raw: unknown): BoardState | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  if (!Array.isArray(o.projects)) return null
  if (o.theme !== 'whiteboard' && o.theme !== 'blackboard') return null
  return raw as BoardState
}

function legacyBoardToWorkspace(board: BoardState): WorkspaceState {
  const id = newId()
  return {
    boards: [
      {
        id,
        title: 'Board',
        theme: board.theme,
        projects: board.projects,
      },
    ],
    activeBoardId: id,
  }
}

export function parseWorkspaceState(raw: unknown): WorkspaceState | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  if (Array.isArray(o.boards) && typeof o.activeBoardId === 'string') {
    const boards: BoardEntry[] = []
    for (const item of o.boards) {
      if (!item || typeof item !== 'object') continue
      const b = item as Record<string, unknown>
      if (typeof b.id !== 'string') continue
      if (!Array.isArray(b.projects)) continue
      const theme =
        b.theme === 'whiteboard' || b.theme === 'blackboard' ? b.theme : 'blackboard'
      const title = typeof b.title === 'string' ? b.title : 'Board'
      boards.push({
        id: b.id,
        title,
        theme,
        projects: b.projects as BoardEntry['projects'],
      })
    }
    if (boards.length === 0) return null
    let activeBoardId = o.activeBoardId
    if (!boards.some((x) => x.id === activeBoardId)) activeBoardId = boards[0].id
    return { boards, activeBoardId }
  }
  const legacy = parseBoardState(raw)
  if (legacy) return legacyBoardToWorkspace(legacy)
  return null
}

/** Flatten all projects for task-change diffing (ids stay stable across boards). */
export function flattenWorkspaceForEvents(ws: WorkspaceState): BoardState {
  const active = ws.boards.find((b) => b.id === ws.activeBoardId)
  return {
    theme: active?.theme ?? 'whiteboard',
    projects: ws.boards.flatMap((b) => b.projects),
  }
}

export function loadWorkspaceFromLocal(): WorkspaceState | null {
  try {
    const w = localStorage.getItem(WORKSPACE_LOCAL_KEY)
    if (w) {
      const parsed = parseWorkspaceState(JSON.parse(w))
      if (parsed) return parsed
    }
    const legacyText = localStorage.getItem(LEGACY_BOARD_LOCAL_KEY)
    if (!legacyText) return null
    const legacy = parseBoardState(JSON.parse(legacyText))
    if (!legacy) return null
    return legacyBoardToWorkspace(legacy)
  } catch {
    return null
  }
}

export function saveWorkspaceToLocal(ws: WorkspaceState): void {
  try {
    localStorage.setItem(WORKSPACE_LOCAL_KEY, JSON.stringify(ws))
  } catch {
    /* quota or private mode */
  }
}

export async function loadWorkspaceFromDisk(): Promise<WorkspaceState | null> {
  try {
    const res = await fetch(DISK_API, { method: 'GET' })
    if (res.status === 404) return null
    if (!res.ok) return null
    const text = await res.text()
    if (!text.trim()) return null
    return parseWorkspaceState(JSON.parse(text))
  } catch {
    return null
  }
}

export async function saveWorkspaceToDisk(ws: WorkspaceState): Promise<void> {
  try {
    const res = await fetch(DISK_API, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(ws),
    })
    if (!res.ok && res.status !== 404) {
      /* 404 should not happen on PUT */
    }
  } catch {
    /* static preview / file:// */
  }
}

export function loadTaskEventsFromLocal(): TaskChangeEvent[] {
  try {
    const text = localStorage.getItem(EVENTS_LOCAL_KEY)
    if (!text) return []
    return parseTaskEvents(JSON.parse(text))
  } catch {
    return []
  }
}

export function saveTaskEventsToLocal(events: TaskChangeEvent[]): void {
  try {
    localStorage.setItem(EVENTS_LOCAL_KEY, JSON.stringify(events))
  } catch {
    /* quota or private mode */
  }
}

export async function loadTaskEventsFromDisk(): Promise<TaskChangeEvent[] | null> {
  try {
    const res = await fetch(EVENTS_DISK_API, { method: 'GET' })
    if (res.status === 404) return null
    if (!res.ok) return null
    const text = await res.text()
    if (!text.trim()) return []
    return parseTaskEvents(JSON.parse(text))
  } catch {
    return null
  }
}

export async function saveTaskEventsToDisk(
  events: TaskChangeEvent[],
): Promise<void> {
  try {
    const res = await fetch(EVENTS_DISK_API, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(events),
    })
    if (!res.ok && res.status !== 404) {
      /* 404 should not happen on PUT */
    }
  } catch {
    /* static preview / file:// */
  }
}

export async function createWeeklyReportOnDisk(input: {
  diffText: string
  weekLabel?: string
  suggestedFilename: string
}): Promise<{ path: string; usedAi?: boolean; error?: string } | null> {
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), WEEKLY_REPORT_CLIENT_TIMEOUT_MS)
  try {
    const res = await fetch(WEEKLY_REPORT_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
      signal: controller.signal,
    })
    if (!res.ok) {
      const body = await res.text()
      let msg = `HTTP ${res.status}`
      try {
        const parsed = JSON.parse(body) as { error?: unknown }
        if (typeof parsed.error === 'string' && parsed.error.trim()) msg = parsed.error
      } catch {
        if (body.trim()) msg = body.trim()
      }
      return { path: '', error: msg }
    }
    const text = await res.text()
    if (!text.trim()) return null
    const parsed = JSON.parse(text) as { path?: unknown; usedAi?: unknown }
    if (!parsed || typeof parsed.path !== 'string') return null
    return {
      path: parsed.path,
      usedAi: typeof parsed.usedAi === 'boolean' ? parsed.usedAi : undefined,
    }
  } catch (e: unknown) {
    if (e instanceof Error && e.name === 'AbortError') {
      return { path: '', error: 'Report generation timed out after 60 seconds.' }
    }
    return null
  } finally {
    clearTimeout(timeoutId)
  }
}
