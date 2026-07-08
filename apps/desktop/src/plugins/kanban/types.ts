/** The slice of the kanban REST contract the board renders. The backend
 *  (`plugins/kanban/dashboard/plugin_api.py`) returns much more per task; we
 *  type only what the UI reads so a schema addition never breaks the build. */

/** One card. `status` is the column id (see COLUMNS). */
export interface KanbanTask {
  id: string
  title: string
  body?: null | string
  status: string
  assignee?: null | string
  priority?: number
  tenant?: null | string
  created_at?: number
  latest_summary?: null | string
  comment_count?: number
  link_counts?: { parents: number; children: number }
  /** N-of-M child completion, or null when the task has no children. */
  progress?: null | { done: number; total: number }
  /** Compact diagnostics rollup — present only when a card has warnings. */
  warnings?: null | { count: number; highest_severity?: null | string }
}

export interface KanbanColumn {
  name: string
  tasks: KanbanTask[]
}

export interface KanbanBoard {
  columns: KanbanColumn[]
  tenants: string[]
  assignees: string[]
  latest_event_id: number
  now: number
}

export interface KanbanTaskDetail extends KanbanTask {
  comments?: Array<{ id: string; author: string; body: string; created_at: number }>
  events?: Array<{ id: number; kind: string; payload: unknown; created_at: number }>
  runs?: Array<{ id: string; status: string; outcome?: null | string; summary?: null | string; error?: null | string }>
}

/** Column presentation: label + codicon + tone. Order follows the backend's
 *  BOARD_COLUMNS; anything the backend adds still renders (fallback meta). */
export const COLUMN_META: Record<string, { label: string; codicon: string; tone: string }> = {
  triage: { label: 'Triage', codicon: 'inbox', tone: 'var(--ui-text-tertiary)' },
  todo: { label: 'Todo', codicon: 'circle-outline', tone: 'var(--ui-text-secondary)' },
  scheduled: { label: 'Scheduled', codicon: 'watch', tone: '#a78bfa' },
  ready: { label: 'Ready', codicon: 'play-circle', tone: '#60a5fa' },
  running: { label: 'Running', codicon: 'sync', tone: '#34d399' },
  blocked: { label: 'Blocked', codicon: 'error', tone: '#f87171' },
  review: { label: 'Review', codicon: 'eye', tone: '#fbbf24' },
  done: { label: 'Done', codicon: 'pass', tone: 'var(--ui-text-tertiary)' },
  archived: { label: 'Archived', codicon: 'archive', tone: 'var(--ui-text-quaternary)' }
}

export const columnMeta = (name: string) =>
  COLUMN_META[name] ?? { label: name, codicon: 'circle-outline', tone: 'var(--ui-text-secondary)' }
