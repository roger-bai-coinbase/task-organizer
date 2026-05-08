export type TaskNote = {
  id: string
  /** Short label in the mini header (double-tap header to edit) */
  title: string
  /** Body / notes; always editable */
  text: string
  /** ISO 8601 timestamp when the task note was created */
  createdAt: string
  x: number
  y: number
  width: number
  height: number
}

export type ProjectNote = {
  id: string
  title: string
  /** ISO 8601 timestamp when the project note was created */
  createdAt: string
  /** 0–360; drives sticky color and mini-note family */
  hue: number
  x: number
  y: number
  width: number
  height: number
  tasks: TaskNote[]
}

export type BoardTheme = 'whiteboard' | 'blackboard'

/** One canvas: theme + project stickies (legacy persisted shape). */
export type BoardState = {
  theme: BoardTheme
  projects: ProjectNote[]
}

/** A named board inside a workspace. */
export type BoardEntry = {
  id: string
  title: string
  theme: BoardTheme
  projects: ProjectNote[]
}

export type WorkspaceState = {
  boards: BoardEntry[]
  activeBoardId: string
}
