import { describe, expect, it } from 'vitest'
import type { BoardState } from './types'
import {
  buildWeeklyDiffText,
  collectTaskEvents,
  formatWeeklyReportWeekLabel,
  mergeTaskEvents,
  type TaskChangeEvent,
} from './taskEvents'

const emptyBoard: BoardState = { theme: 'blackboard', projects: [] }

const boardWithTask = (text: string, title = 'Task'): BoardState => ({
  theme: 'blackboard',
  projects: [
    {
      id: 'project-1',
      title: 'Project',
      createdAt: '2026-06-01T00:00:00.000Z',
      hue: 48,
      x: 0,
      y: 0,
      width: 400,
      height: 300,
      tasks: [
        {
          id: 'task-1',
          title,
          text,
          createdAt: '2026-06-01T00:00:00.000Z',
          x: 0,
          y: 0,
          width: 120,
          height: 90,
        },
      ],
    },
  ],
})

describe('taskEvents', () => {
  it('collects created, updated, and deleted task events', () => {
    const created = collectTaskEvents(
      emptyBoard,
      boardWithTask('Initial'),
      '2026-06-24T12:00:00.000Z',
    )
    expect(created).toMatchObject([{ kind: 'created', text: 'Initial' }])

    const updated = collectTaskEvents(
      boardWithTask('Initial'),
      boardWithTask('Changed', 'Renamed'),
      '2026-06-24T12:01:00.000Z',
    )
    expect(updated).toMatchObject([
      {
        kind: 'updated',
        changes: [
          { field: 'title', before: 'Task', after: 'Renamed' },
          { field: 'text', before: 'Initial', after: 'Changed' },
        ],
      },
    ])

    const deleted = collectTaskEvents(
      boardWithTask('Changed'),
      emptyBoard,
      '2026-06-24T12:02:00.000Z',
    )
    expect(deleted).toMatchObject([
      { kind: 'deleted', reason: 'project_removed', text: 'Changed' },
    ])
  })

  it('merges adjacent updates for the same task', () => {
    const events: TaskChangeEvent[] = [
      {
        kind: 'updated',
        at: '2026-06-24T12:00:00.000Z',
        projectId: 'project-1',
        projectTitle: 'Project',
        taskId: 'task-1',
        taskTitle: 'Task',
        changes: [{ field: 'text', before: 'a', after: 'b' }],
      },
      {
        kind: 'updated',
        at: '2026-06-24T12:03:00.000Z',
        projectId: 'project-1',
        projectTitle: 'Project',
        taskId: 'task-1',
        taskTitle: 'Task',
        changes: [{ field: 'text', before: 'b', after: 'c' }],
      },
    ]

    expect(mergeTaskEvents([], events)).toMatchObject([
      {
        kind: 'updated',
        changes: [{ field: 'text', before: 'a', after: 'c' }],
      },
    ])
  })

  it('builds a weekly diff with live links and without deleted events', () => {
    const now = new Date('2026-06-26T16:00:00.000Z')
    const events: TaskChangeEvent[] = [
      {
        kind: 'created',
        at: '2026-06-24T12:00:00.000Z',
        projectId: 'project-1',
        projectTitle: 'Project',
        taskId: 'task-1',
        taskTitle: 'Task',
        text: 'Initial',
      },
      {
        kind: 'deleted',
        at: '2026-06-24T13:00:00.000Z',
        projectId: 'project-1',
        projectTitle: 'Project',
        taskId: 'task-2',
        taskTitle: 'Deleted',
        text: 'Should be excluded',
        reason: 'task_removed',
      },
    ]

    const diff = buildWeeklyDiffText(
      events,
      now,
      new Map([['project-1:task-1', 'Current [Doc](https://example.com/doc)']]),
    )
    expect(diff).toContain('Week: Jun 20, 2026 - Jun 26, 2026')
    expect(diff).toContain('PROJECT: Project')
    expect(diff).toContain('[Doc](https://example.com/doc)')
    expect(diff).not.toContain('Should be excluded')
  })

  it('formats the same calendar week label used by weekly diffs', () => {
    expect(formatWeeklyReportWeekLabel(new Date('2026-06-26T16:00:00.000Z'))).toBe(
      'Jun 20, 2026 - Jun 26, 2026',
    )
  })
})
