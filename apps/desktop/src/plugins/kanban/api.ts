/**
 * Kanban data layer. Everything goes through `ctx.rest` — the plugin's own
 * `/api/plugins/kanban/*` FastAPI router (`plugins/kanban/dashboard/plugin_api.py`),
 * reused as-is via the desktop's namespace-scoped REST door. No new backend.
 *
 * One shared `$board` atom + poll loop feeds BOTH the board page and the
 * statusbar count, so the two never double-fetch. Live task-events ride a
 * plugin WebSocket the SDK doesn't expose yet, so we poll (like the logs pane);
 * the page nudges an immediate refresh on mount + after a drag.
 */

import { atom, host, type PluginRestOptions } from '@hermes/plugin-sdk'

import type { KanbanBoard, KanbanTaskDetail } from './types'

type Rest = <T>(path: string, opts?: PluginRestOptions) => Promise<T>

let rest: null | Rest = null

/** Bind the plugin's REST door once, at register time. */
export function bindApi(r: Rest): void {
  rest = r
}

function call<T>(path: string, opts?: PluginRestOptions): Promise<T> {
  return rest ? rest<T>(path, opts) : Promise.reject(new Error('kanban api not ready'))
}

export const $board = atom<KanbanBoard | null>(null)
export const $boardError = atom<null | string>(null)

export const fetchTask = (id: string) => call<KanbanTaskDetail>(`/tasks/${id}`)

export const patchTask = (id: string, patch: Record<string, unknown>) =>
  call(`/tasks/${id}`, { method: 'PATCH', body: patch })

export async function refreshBoard(): Promise<void> {
  try {
    $board.set(await call<KanbanBoard>('/board'))
    $boardError.set(null)
  } catch (error) {
    $boardError.set(error instanceof Error ? error.message : String(error))
  }
}

const POLL_MS = 8_000
let polling = false

/** Start the single shared poll — refreshes while the gateway is open, idles
 *  otherwise. Idempotent across enable/disable toggles. */
export function startBoardPoll(): void {
  if (polling) {
    return
  }

  polling = true
  let timer: null | number = null

  const stop = () => {
    if (timer !== null) {
      window.clearInterval(timer)
      timer = null
    }
  }

  const sync = (gateway: string) => {
    if (gateway !== 'open') {
      stop()

      return
    }

    if (timer === null) {
      void refreshBoard()
      timer = window.setInterval(() => void refreshBoard(), POLL_MS)
    }
  }

  sync(host.state.gateway.get())
  host.state.gateway.listen(sync)
}
