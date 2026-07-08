/**
 * The Kanban board page — mounted at `/kanban` (a ROUTES_AREA contribution) in
 * the workspace pane. Columns come straight from the backend in BOARD_COLUMNS
 * order; a card drag PATCHes the task's status (optimistic, then reconciled);
 * clicking a card opens a detail dialog. Pure SDK consumer — the only imports
 * are `@hermes/plugin-sdk`, react, and this plugin's own api/types.
 */

import {
  Badge,
  Button,
  cn,
  Codicon,
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  ErrorState,
  GlyphSpinner,
  Input,
  ScrollArea,
  Textarea,
  useValue
} from '@hermes/plugin-sdk'
import { useEffect, useState } from 'react'

import { $board, $boardError, createTask, fetchTask, patchTask, refreshBoard } from './api'
import { columnMeta, type KanbanBoard, type KanbanTask, type KanbanTaskDetail } from './types'

// Optimistically relocate a card so the drop lands instantly; the follow-up
// refresh reconciles against the server (priority/order, rejected moves).
function moveCard(board: KanbanBoard, id: string, toStatus: string): KanbanBoard {
  let moved: KanbanTask | undefined

  const columns = board.columns.map(col => ({
    ...col,
    tasks: col.tasks.filter(task => {
      if (task.id !== id) {
        return true
      }

      moved = { ...task, status: toStatus }

      return false
    })
  }))

  if (!moved) {
    return board
  }

  return {
    ...board,
    columns: columns.map(col => (col.name === toStatus ? { ...col, tasks: [moved!, ...col.tasks] } : col))
  }
}

function CardBadges({ task }: { task: KanbanTask }) {
  return (
    <div className="flex flex-wrap items-center gap-1 text-[0.625rem] text-(--ui-text-tertiary)">
      {task.assignee && (
        <span className="inline-flex items-center gap-1">
          <Codicon name="account" size="0.7rem" />
          {task.assignee}
        </span>
      )}
      {task.progress && task.progress.total > 0 && (
        <span className="inline-flex items-center gap-1">
          <Codicon name="checklist" size="0.7rem" />
          {task.progress.done}/{task.progress.total}
        </span>
      )}
      {Boolean(task.comment_count) && (
        <span className="inline-flex items-center gap-1">
          <Codicon name="comment" size="0.7rem" />
          {task.comment_count}
        </span>
      )}
      {task.link_counts && task.link_counts.parents + task.link_counts.children > 0 && (
        <span className="inline-flex items-center gap-1">
          <Codicon name="references" size="0.7rem" />
          {task.link_counts.parents + task.link_counts.children}
        </span>
      )}
      {task.warnings && task.warnings.count > 0 && (
        <span className="inline-flex items-center gap-1 text-(--ui-danger,#f87171)">
          <Codicon name="warning" size="0.7rem" />
          {task.warnings.count}
        </span>
      )}
    </div>
  )
}

function Card({ onOpen, task }: { onOpen: (id: string) => void; task: KanbanTask }) {
  const summary = task.latest_summary || task.body

  return (
    <button
      className={cn(
        'group flex w-full flex-col gap-1.5 rounded-md border border-(--ui-stroke-tertiary) bg-(--ui-surface-raised)',
        'px-2.5 py-2 text-left transition-colors hover:border-(--ui-stroke-secondary) hover:bg-(--chrome-action-hover)',
        'cursor-grab active:cursor-grabbing'
      )}
      draggable
      onClick={() => onOpen(task.id)}
      onDragStart={event => {
        event.dataTransfer.setData('text/plain', task.id)
        event.dataTransfer.effectAllowed = 'move'
      }}
      type="button"
    >
      <span className="line-clamp-2 text-[0.8125rem] font-medium text-foreground">{task.title || task.id}</span>
      {summary && <span className="line-clamp-2 text-[0.6875rem] text-(--ui-text-tertiary)">{summary}</span>}
      <CardBadges task={task} />
    </button>
  )
}

function Column({
  onAdd,
  onDropTask,
  onOpen,
  tasks,
  name
}: {
  name: string
  onAdd: (status: string) => void
  onDropTask: (id: string, status: string) => void
  onOpen: (id: string) => void
  tasks: KanbanTask[]
}) {
  const [over, setOver] = useState(false)
  const meta = columnMeta(name)

  return (
    <div className="group/col flex h-full w-72 shrink-0 flex-col">
      <div className="mb-1.5 flex items-center gap-1.5 px-1">
        <Codicon name={meta.codicon} size="0.8rem" style={{ color: meta.tone }} />
        <span className="text-[0.75rem] font-semibold uppercase tracking-wide text-(--ui-text-secondary)">
          {meta.label}
        </span>
        <span className="ml-auto text-[0.6875rem] tabular-nums text-(--ui-text-quaternary)">{tasks.length}</span>
        <button
          aria-label={`New task in ${meta.label}`}
          className="grid size-4 place-items-center rounded text-(--ui-text-tertiary) opacity-0 transition-opacity hover:bg-(--chrome-action-hover) hover:text-foreground focus-visible:opacity-100 group-hover/col:opacity-100"
          onClick={() => onAdd(name)}
          type="button"
        >
          <Codicon name="add" size="0.75rem" />
        </button>
      </div>
      <div
        className={cn(
          'flex min-h-0 flex-1 flex-col gap-1.5 overflow-y-auto rounded-lg border border-transparent p-1.5 transition-colors',
          over && 'border-(--ui-stroke-secondary) bg-(--ui-control-hover-background)'
        )}
        onDragLeave={() => setOver(false)}
        onDragOver={event => {
          event.preventDefault()
          event.dataTransfer.dropEffect = 'move'
          setOver(true)
        }}
        onDrop={event => {
          event.preventDefault()
          setOver(false)
          const id = event.dataTransfer.getData('text/plain')

          if (id) {
            onDropTask(id, name)
          }
        }}
      >
        {tasks.map(task => (
          <Card key={task.id} onOpen={onOpen} task={task} />
        ))}
      </div>
    </div>
  )
}

function TaskDialog({ id, onClose }: { id: null | string; onClose: () => void }) {
  const [task, setTask] = useState<KanbanTaskDetail | null>(null)
  const [error, setError] = useState<null | string>(null)

  useEffect(() => {
    if (!id) {
      return
    }

    let cancelled = false
    setTask(null)
    setError(null)

    fetchTask(id)
      .then(detail => !cancelled && setTask(detail))
      .catch(err => !cancelled && setError(err instanceof Error ? err.message : String(err)))

    return () => {
      cancelled = true
    }
  }, [id])

  return (
    <Dialog onOpenChange={open => !open && onClose()} open={Boolean(id)}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {task ? (
              <>
                <Badge>{columnMeta(task.status).label}</Badge>
                <span className="truncate">{task.title || task.id}</span>
              </>
            ) : (
              (id ?? '')
            )}
          </DialogTitle>
        </DialogHeader>

        {error ? (
          <ErrorState title={error} />
        ) : !task ? (
          <div className="grid h-32 place-items-center">
            <GlyphSpinner />
          </div>
        ) : (
          <ScrollArea className="max-h-[60vh]">
            <div className="flex flex-col gap-4 pr-3 text-sm">
              <div className="flex flex-wrap gap-x-4 gap-y-1 text-[0.6875rem] text-(--ui-text-tertiary)">
                <span>id {task.id}</span>
                {task.assignee && <span>assignee {task.assignee}</span>}
                {task.tenant && <span>tenant {task.tenant}</span>}
                {typeof task.priority === 'number' && <span>priority {task.priority}</span>}
              </div>

              {task.body && (
                <section>
                  <SectionLabel>Body</SectionLabel>
                  <p className="whitespace-pre-wrap text-[0.8125rem] text-(--ui-text-secondary)">{task.body}</p>
                </section>
              )}

              {task.latest_summary && (
                <section>
                  <SectionLabel>Latest summary</SectionLabel>
                  <p className="whitespace-pre-wrap text-[0.8125rem] text-(--ui-text-secondary)">
                    {task.latest_summary}
                  </p>
                </section>
              )}

              {task.runs && task.runs.length > 0 && (
                <section>
                  <SectionLabel>Runs</SectionLabel>
                  <ul className="flex flex-col gap-1">
                    {task.runs.map(run => (
                      <li className="flex items-center gap-2 text-[0.75rem]" key={run.id}>
                        <Badge>{run.outcome ?? run.status}</Badge>
                        <span className="truncate text-(--ui-text-tertiary)">{run.summary ?? run.error ?? run.id}</span>
                      </li>
                    ))}
                  </ul>
                </section>
              )}

              {task.comments && task.comments.length > 0 && (
                <section>
                  <SectionLabel>Comments</SectionLabel>
                  <ul className="flex flex-col gap-2">
                    {task.comments.map(comment => (
                      <li className="text-[0.75rem]" key={comment.id}>
                        <span className="font-medium text-(--ui-text-secondary)">{comment.author}</span>
                        <p className="whitespace-pre-wrap text-(--ui-text-tertiary)">{comment.body}</p>
                      </li>
                    ))}
                  </ul>
                </section>
              )}
            </div>
          </ScrollArea>
        )}
      </DialogContent>
    </Dialog>
  )
}

function SectionLabel({ children }: { children: string }) {
  return (
    <div className="mb-1 text-[0.62rem] font-semibold uppercase tracking-[0.14em] text-(--ui-text-quaternary)">
      {children}
    </div>
  )
}

function NewTaskDialog({ onClose, target }: { onClose: () => void; target: null | string }) {
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<null | string>(null)

  useEffect(() => {
    if (target) {
      setTitle('')
      setBody('')
      setError(null)
      setBusy(false)
    }
  }, [target])

  const submit = async () => {
    const trimmed = title.trim()

    if (!trimmed || !target || busy) {
      return
    }

    setBusy(true)
    setError(null)

    try {
      // create() derives status (triage flag → 'triage', else 'ready'); move to
      // the requested column when they differ, so a per-column "+" lands right.
      const { task } = await createTask({ title: trimmed, body: body.trim() || undefined, triage: target === 'triage' })

      if (task && task.status !== target) {
        await patchTask(task.id, { status: target })
      }

      await refreshBoard()
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setBusy(false)
    }
  }

  return (
    <Dialog onOpenChange={open => !open && onClose()} open={Boolean(target)}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>New task{target ? ` — ${columnMeta(target).label}` : ''}</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <Input
            autoFocus
            onChange={event => setTitle(event.target.value)}
            onKeyDown={event => {
              if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                void submit()
              }
            }}
            placeholder="Title"
            value={title}
          />
          <Textarea
            className="min-h-24"
            onChange={event => setBody(event.target.value)}
            placeholder="Description (optional)"
            value={body}
          />
          {error && <span className="text-[0.75rem] text-(--ui-danger,#f87171)">{error}</span>}
        </div>
        <DialogFooter>
          <Button onClick={onClose} variant="ghost">
            Cancel
          </Button>
          <Button disabled={!title.trim() || busy} onClick={() => void submit()}>
            {busy ? 'Creating…' : 'Create'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export function KanbanBoardPage() {
  const board = useValue($board)
  const error = useValue($boardError)
  const [openId, setOpenId] = useState<null | string>(null)
  const [addStatus, setAddStatus] = useState<null | string>(null)

  useEffect(() => {
    void refreshBoard()
  }, [])

  const onDropTask = (id: string, status: string) => {
    const current = $board.get()

    if (!current) {
      return
    }

    const task = current.columns.flatMap(col => col.tasks).find(candidate => candidate.id === id)

    if (!task || task.status === status) {
      return
    }

    $board.set(moveCard(current, id, status))
    void patchTask(id, { status }).then(refreshBoard, refreshBoard)
  }

  const total = board?.columns.reduce((sum, col) => sum + col.tasks.length, 0) ?? 0

  return (
    <div className="flex h-full flex-col overflow-hidden bg-(--ui-surface-base)">
      <header className="flex shrink-0 items-center gap-2 border-b border-(--ui-stroke-tertiary) px-4 py-2.5">
        <Codicon name="project" size="1rem" />
        <h1 className="text-sm font-semibold text-foreground">Kanban</h1>
        <span className="text-[0.6875rem] tabular-nums text-(--ui-text-quaternary)">{total} tasks</span>
        <Button className="ml-auto" onClick={() => setAddStatus('triage')} size="sm" variant="ghost">
          <Codicon name="add" size="0.8rem" />
          New task
        </Button>
        <Button onClick={() => void refreshBoard()} size="sm" variant="ghost">
          <Codicon name="refresh" size="0.8rem" />
          Refresh
        </Button>
      </header>

      {error && !board ? (
        <div className="grid flex-1 place-items-center">
          <ErrorState title={error} />
        </div>
      ) : !board ? (
        <div className="grid flex-1 place-items-center">
          <GlyphSpinner />
        </div>
      ) : total === 0 ? (
        <div className="grid flex-1 place-items-center px-4 text-center">
          <div className="flex flex-col items-center gap-2">
            <Codicon className="text-(--ui-text-quaternary)" name="project" size="1.25rem" />
            <p className="text-xs text-(--ui-text-tertiary)">No tasks on this board</p>
            <Button className="mt-0.5" onClick={() => setAddStatus('triage')} size="sm" variant="outline">
              <Codicon name="add" size="0.75rem" />
              New task
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-1 gap-3 overflow-x-auto p-3">
          {board.columns.map(col => (
            <Column
              key={col.name}
              name={col.name}
              onAdd={setAddStatus}
              onDropTask={onDropTask}
              onOpen={setOpenId}
              tasks={col.tasks}
            />
          ))}
        </div>
      )}

      <NewTaskDialog onClose={() => setAddStatus(null)} target={addStatus} />
      <TaskDialog id={openId} onClose={() => setOpenId(null)} />
    </div>
  )
}
