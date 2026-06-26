import { describe, expect, it } from 'vitest'
import { flattenWorkspaceForEvents, parseBoardState, parseWorkspaceState } from './storage'

const task = {
  id: 'task-1',
  title: 'Task',
  text: 'Notes',
  createdAt: '2026-06-01T00:00:00.000Z',
  x: 1,
  y: 2,
  width: 120,
  height: 90,
}

const project = {
  id: 'project-1',
  title: 'Project',
  createdAt: '2026-06-01T00:00:00.000Z',
  hue: 48,
  x: 10,
  y: 20,
  width: 400,
  height: 300,
  tasks: [task],
}

describe('storage parsers', () => {
  it('parses a valid workspace and normalizes missing optional board fields', () => {
    expect(
      parseWorkspaceState({
        activeBoardId: 'board-1',
        boards: [{ id: 'board-1', projects: [project] }],
      }),
    ).toEqual({
      activeBoardId: 'board-1',
      boards: [
        {
          id: 'board-1',
          title: 'Board',
          theme: 'blackboard',
          projects: [project],
        },
      ],
    })
  })

  it('rejects malformed nested project and task data', () => {
    expect(
      parseWorkspaceState({
        activeBoardId: 'board-1',
        boards: [
          {
            id: 'board-1',
            title: 'Board',
            theme: 'blackboard',
            projects: [{ ...project, tasks: [{ ...task, width: 'wide' }] }],
          },
        ],
      }),
    ).toBeNull()
  })

  it('migrates a legacy board into a workspace', () => {
    const migrated = parseWorkspaceState({
      theme: 'whiteboard',
      projects: [project],
    })

    expect(migrated?.activeBoardId).toBe(migrated?.boards[0]?.id)
    expect(migrated?.boards[0]).toMatchObject({
      title: 'Board',
      theme: 'whiteboard',
      projects: [project],
    })
  })

  it('parses valid legacy board state directly', () => {
    expect(parseBoardState({ theme: 'blackboard', projects: [project] })).toEqual({
      theme: 'blackboard',
      projects: [project],
    })
  })

  it('flattens all workspace projects for task event collection', () => {
    const ws = parseWorkspaceState({
      activeBoardId: 'board-1',
      boards: [
        { id: 'board-1', theme: 'whiteboard', title: 'One', projects: [project] },
        {
          id: 'board-2',
          theme: 'blackboard',
          title: 'Two',
          projects: [{ ...project, id: 'project-2' }],
        },
      ],
    })

    expect(ws).not.toBeNull()
    expect(flattenWorkspaceForEvents(ws!).projects.map((p) => p.id)).toEqual([
      'project-1',
      'project-2',
    ])
  })
})
