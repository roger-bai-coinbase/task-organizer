import type { BoardState, ProjectNote, TaskNote } from './types'

export type TaskField = 'title' | 'text'

export type TaskFieldDelta = {
  field: TaskField
  before: string
  after: string
}

export type TaskChangeEvent =
  | {
      kind: 'created'
      at: string
      projectId: string
      projectTitle: string
      taskId: string
      taskTitle: string
      text: string
    }
  | {
      kind: 'updated'
      at: string
      projectId: string
      projectTitle: string
      taskId: string
      taskTitle: string
      changes: TaskFieldDelta[]
    }
  | {
      kind: 'deleted'
      at: string
      projectId: string
      projectTitle: string
      taskId: string
      taskTitle: string
      text: string
      reason: 'task_removed' | 'project_removed'
    }

type TaskRef = { project: ProjectNote; task: TaskNote }

function key(projectId: string, taskId: string): string {
  return `${projectId}:${taskId}`
}

function mapTasks(board: BoardState): Map<string, TaskRef> {
  const out = new Map<string, TaskRef>()
  for (const p of board.projects) {
    for (const t of p.tasks) out.set(key(p.id, t.id), { project: p, task: t })
  }
  return out
}

function clipped(s: string, max = 90): string {
  const one = s.replace(/\s+/g, ' ').trim()
  if (one.length <= max) return one
  return `${one.slice(0, max)}…`
}

export function collectTaskEvents(
  prev: BoardState,
  next: BoardState,
  at: string,
): TaskChangeEvent[] {
  const out: TaskChangeEvent[] = []
  const prevTasks = mapTasks(prev)
  const nextTasks = mapTasks(next)
  const nextProjectIds = new Set(next.projects.map((p) => p.id))

  for (const [k, n] of nextTasks) {
    const p = prevTasks.get(k)
    if (!p) {
      out.push({
        kind: 'created',
        at,
        projectId: n.project.id,
        projectTitle: n.project.title,
        taskId: n.task.id,
        taskTitle: n.task.title,
        text: n.task.text,
      })
      continue
    }
    const changes: TaskFieldDelta[] = []
    if (p.task.title !== n.task.title) {
      changes.push({ field: 'title', before: p.task.title, after: n.task.title })
    }
    if (p.task.text !== n.task.text) {
      changes.push({ field: 'text', before: p.task.text, after: n.task.text })
    }
    if (changes.length > 0) {
      out.push({
        kind: 'updated',
        at,
        projectId: n.project.id,
        projectTitle: n.project.title,
        taskId: n.task.id,
        taskTitle: n.task.title,
        changes,
      })
    }
  }

  for (const [k, p] of prevTasks) {
    if (nextTasks.has(k)) continue
    out.push({
      kind: 'deleted',
      at,
      projectId: p.project.id,
      projectTitle: p.project.title,
      taskId: p.task.id,
      taskTitle: p.task.title,
      text: p.task.text,
      reason: nextProjectIds.has(p.project.id) ? 'task_removed' : 'project_removed',
    })
  }

  return out
}

function sameTask(a: TaskChangeEvent, b: TaskChangeEvent): boolean {
  return a.projectId === b.projectId && a.taskId === b.taskId
}

function ms(iso: string): number {
  const v = Date.parse(iso)
  return Number.isNaN(v) ? 0 : v
}

/** Keep updates compact by merging adjacent task updates in a short time window. */
function mergeAdjacentUpdates(
  prev: TaskChangeEvent,
  next: TaskChangeEvent,
): TaskChangeEvent | null {
  if (prev.kind !== 'updated' || next.kind !== 'updated') return null
  if (!sameTask(prev, next)) return null
  if (Math.abs(ms(next.at) - ms(prev.at)) > 5 * 60 * 1000) return null

  const byField = new Map<TaskField, TaskFieldDelta>()
  for (const c of prev.changes) byField.set(c.field, c)
  for (const c of next.changes) {
    const ex = byField.get(c.field)
    if (!ex) byField.set(c.field, c)
    else byField.set(c.field, { field: c.field, before: ex.before, after: c.after })
  }
  return {
    ...next,
    changes: Array.from(byField.values()),
  }
}

export function mergeTaskEvents(
  existing: TaskChangeEvent[],
  incoming: TaskChangeEvent[],
): TaskChangeEvent[] {
  const sorted = [...existing, ...incoming].sort((a, b) => ms(a.at) - ms(b.at))
  const compact: TaskChangeEvent[] = []
  for (const e of sorted) {
    const last = compact[compact.length - 1]
    if (!last) {
      compact.push(e)
      continue
    }
    const merged = mergeAdjacentUpdates(last, e)
    if (merged) compact[compact.length - 1] = merged
    else compact.push(e)
  }
  const cutoff = Date.now() - 90 * 24 * 60 * 60 * 1000
  return compact.filter((e) => ms(e.at) >= cutoff).slice(-6000)
}

function fmtDay(iso: string): string {
  const d = new Date(ms(iso))
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  }).format(d)
}

function fmtTime(iso: string): string {
  const d = new Date(ms(iso))
  return new Intl.DateTimeFormat(undefined, {
    hour: 'numeric',
    minute: '2-digit',
  }).format(d)
}

function splitMeaningfulLines(text: string): string[] {
  return text
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((x) => x.trim())
    .filter((x) => x.length > 0)
}

type NotesSummary = {
  headline: string
  details: string[]
}

function summarizeNotesChanges(before: string, after: string): NotesSummary {
  const oldLines = splitMeaningfulLines(before)
  const newLines = splitMeaningfulLines(after)
  const details: string[] = []
  let updated = 0
  let added = 0
  let removed = 0
  const n = Math.max(oldLines.length, newLines.length)

  for (let i = 0; i < n; i++) {
    const oldLine = oldLines[i]
    const newLine = newLines[i]
    if (typeof newLine === 'string' && typeof oldLine === 'string') {
      if (newLine !== oldLine) {
        updated += 1
        if (details.length < 2) {
          details.push(
            `Updated: "${clipped(oldLine, 64)}" -> "${clipped(newLine, 64)}"`,
          )
        }
      }
      continue
    }
    if (typeof newLine === 'string') {
      added += 1
      if (details.length < 2) {
        details.push(`Added: "${clipped(newLine, 64)}"`)
      }
      continue
    }
    if (typeof oldLine === 'string') {
      removed += 1
      if (details.length < 2) {
        details.push(`Removed: "${clipped(oldLine, 64)}"`)
      }
    }
  }

  const parts: string[] = []
  if (updated > 0) parts.push(`${updated} updated`)
  if (added > 0) parts.push(`${added} added`)
  if (removed > 0) parts.push(`${removed} removed`)
  const total = updated + added + removed
  const headline =
    parts.length > 0
      ? `Notes refined (${parts.join(', ')}; ${total} line${total === 1 ? '' : 's'} changed)`
      : 'Notes adjusted'
  return { headline, details }
}

export function parseTaskEvents(raw: unknown): TaskChangeEvent[] {
  if (!Array.isArray(raw)) return []
  return raw.filter((x) => {
    if (!x || typeof x !== 'object') return false
    const o = x as Record<string, unknown>
    if (typeof o.kind !== 'string') return false
    if (typeof o.at !== 'string') return false
    if (typeof o.projectId !== 'string') return false
    if (typeof o.projectTitle !== 'string') return false
    if (typeof o.taskId !== 'string') return false
    if (typeof o.taskTitle !== 'string') return false
    return o.kind === 'created' || o.kind === 'updated' || o.kind === 'deleted'
  }) as TaskChangeEvent[]
}

export function buildWeeklyReportMarkdown(
  events: TaskChangeEvent[],
  now: Date,
): string {
  const w = weeklyWindow(events, now)
  const { week, startLabel, endLabel } = w
  const lines: string[] = []
  lines.push(`# Weekly Updates`)
  lines.push(``)
  lines.push(`Week: ${startLabel} - ${endLabel}`)
  lines.push(`Generated: ${fmtDay(now.toISOString())} ${fmtTime(now.toISOString())}`)
  lines.push(``)

  if (week.length === 0) {
    lines.push(`No task changes were recorded in the past week.`)
    return lines.join('\n')
  }

  const byProject = new Map<string, TaskChangeEvent[]>()
  const projectOrder: string[] = []
  for (const e of week) {
    const k = `${e.projectId}::${e.projectTitle || 'Untitled project'}`
    if (!byProject.has(k)) {
      byProject.set(k, [])
      projectOrder.push(k)
    }
    byProject.get(k)?.push(e)
  }

  for (const pk of projectOrder) {
    const items = byProject.get(pk) ?? []
    const projectTitle = pk.split('::')[1] || 'Untitled project'
    lines.push(`## ${projectTitle}`)
    lines.push(``)

    const byTask = new Map<string, TaskChangeEvent[]>()
    const taskOrder: string[] = []
    for (const e of items) {
      const title = e.taskTitle.trim() || 'Untitled task'
      const tk = `${e.taskId}::${title}`
      if (!byTask.has(tk)) {
        byTask.set(tk, [])
        taskOrder.push(tk)
      }
      byTask.get(tk)?.push(e)
    }

    for (const tk of taskOrder) {
      const evs = byTask.get(tk) ?? []
      const taskTitle = tk.split('::')[1] || 'Untitled task'
      lines.push(`### ${taskTitle}`)
      lines.push(``)
      for (const e of evs) {
        if (e.kind === 'created') {
          lines.push(`- New task created`)
          const initial = splitMeaningfulLines(e.text)
          if (initial.length > 0) {
            lines.push(`  - Initial notes added (${initial.length} lines)`)
            for (const row of initial.slice(0, 2)) {
              lines.push(`    - "${clipped(row, 64)}"`)
            }
          }
        } else if (e.kind === 'updated') {
          if (e.changes.length === 0) {
            lines.push(`- Task updated`)
          } else {
            lines.push(`- Task updated`)
            for (const c of e.changes) {
              if (c.field === 'title') {
                lines.push(
                  `  - Renamed: "${clipped(c.before, 56)}" -> "${clipped(c.after, 56)}"`,
                )
              } else {
                const summary = summarizeNotesChanges(c.before, c.after)
                lines.push(`  - ${summary.headline}`)
                for (const row of summary.details) {
                  lines.push(`    - ${row}`)
                }
              }
            }
          }
        }
      }
      lines.push(``)
    }
  }
  return lines.join('\n')
}

type WeeklyWindow = {
  startMs: number
  endMs: number
  startLabel: string
  endLabel: string
  week: TaskChangeEvent[]
}

function weeklyWindow(events: TaskChangeEvent[], now: Date): WeeklyWindow {
  const endMs = now.getTime()
  const startMs = endMs - 7 * 24 * 60 * 60 * 1000
  const week = events
    .filter((e) => {
      const t = ms(e.at)
      return t >= startMs && t <= endMs
    })
    /* Task removal ("closed") is excluded: closures are expected next week after
       the work week, so they should not appear in this window's report. */
    .filter((e) => e.kind !== 'deleted')
    .sort((a, b) => ms(a.at) - ms(b.at))
  return {
    startMs,
    endMs,
    startLabel: fmtDay(new Date(startMs).toISOString()),
    endLabel: fmtDay(new Date(endMs).toISOString()),
    week,
  }
}

/**
 * Temporary weekly diff artifact for AI summarization.
 * It intentionally stays more literal/structured than final markdown.
 */
export function buildWeeklyDiffText(events: TaskChangeEvent[], now: Date): string {
  const w = weeklyWindow(events, now)
  const lines: string[] = []
  lines.push(`# Weekly Task Diff`)
  lines.push(`Week: ${w.startLabel} - ${w.endLabel}`)
  lines.push(`Generated: ${fmtDay(now.toISOString())} ${fmtTime(now.toISOString())}`)
  lines.push(``)
  if (w.week.length === 0) {
    lines.push(`No task changes in the selected week.`)
    return lines.join('\n')
  }

  for (const e of w.week) {
    const project = e.projectTitle.trim() || 'Untitled project'
    const task = e.taskTitle.trim() || 'Untitled task'
    lines.push(`PROJECT: ${project}`)
    lines.push(`TASK: ${task}`)
    if (e.kind === 'created') {
      lines.push(`EVENT: created`)
      const body = splitMeaningfulLines(e.text)
      if (body.length > 0) {
        lines.push(`INITIAL_CONTENT:`)
        for (const row of body) lines.push(`+ ${row}`)
      }
    } else if (e.kind === 'updated') {
      lines.push(`EVENT: content_changed`)
      for (const c of e.changes) {
        if (c.field === 'title') {
          lines.push(`TITLE_DIFF: "${c.before}" -> "${c.after}"`)
        } else {
          lines.push(`CONTENT_CHANGES:`)
          const before = splitMeaningfulLines(c.before)
          const after = splitMeaningfulLines(c.after)
          const n = Math.max(before.length, after.length)
          for (let i = 0; i < n; i++) {
            const b = before[i]
            const a = after[i]
            if (typeof b === 'string' && typeof a === 'string') {
              if (b === a) lines.push(`= ${b}`)
              else lines.push(`~ "${b}" -> "${a}"`)
            } else if (typeof a === 'string') {
              lines.push(`+ ${a}`)
            } else if (typeof b === 'string') {
              lines.push(`- ${b}`)
            }
          }
        }
      }
    }
    lines.push(``)
  }
  return lines.join('\n')
}
