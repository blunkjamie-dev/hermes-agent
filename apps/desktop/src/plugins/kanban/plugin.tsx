/**
 * Kanban — the founding plugin use case, now pure SDK-consumer work: a
 * first-class `/kanban` board page + sidebar nav row + a live statusbar count,
 * all reusing the existing `plugins/kanban/dashboard/plugin_api.py` REST router
 * through `ctx.rest` (namespace-scoped to `/api/plugins/kanban`). No new
 * backend, no core edits.
 *
 * Ships OFF by default (`defaultEnabled: false`): it inventories in
 * Settings ▸ Plugins and registers nothing until the user flips the switch.
 */

import {
  cn,
  Codicon,
  type HermesPlugin,
  host,
  PALETTE_AREA,
  type PaletteContribution,
  type RouteContribution,
  ROUTES_AREA,
  SIDEBAR_NAV_AREA,
  type SidebarNavContribution,
  STATUSBAR_AREAS,
  useValue
} from '@hermes/plugin-sdk'

import { $board, bindApi, startBoardPoll } from './api'
import { KanbanBoardPage } from './board'

// Live "N running / ready" pill — one glance at fleet activity from anywhere,
// clicks through to the board. Hidden when nothing is in flight (or unloaded).
function KanbanCount() {
  const board = useValue($board)

  if (!board) {
    return null
  }

  const count = (name: string) => board.columns.find(col => col.name === name)?.tasks.length ?? 0
  const active = count('running') + count('ready')

  if (active === 0) {
    return null
  }

  return (
    <button
      className={cn(
        'inline-flex h-full items-center gap-1 rounded-none px-1.5 text-[0.6875rem] tabular-nums transition-colors',
        'text-(--ui-text-tertiary) hover:bg-(--chrome-action-hover) hover:text-foreground'
      )}
      onClick={() => host.navigate('/kanban')}
      title={`Kanban — ${count('running')} running, ${count('ready')} ready`}
      type="button"
    >
      <Codicon name="project" size="0.7rem" />
      <span>{active}</span>
    </button>
  )
}

const plugin: HermesPlugin = {
  id: 'kanban',
  name: 'Kanban',
  defaultEnabled: false,
  register(ctx) {
    bindApi(ctx.rest)
    startBoardPoll()

    ctx.registerMany([
      {
        id: 'page',
        area: ROUTES_AREA,
        data: { path: '/kanban' } satisfies RouteContribution,
        render: () => <KanbanBoardPage />
      },
      {
        id: 'nav',
        area: SIDEBAR_NAV_AREA,
        order: 50,
        data: { codicon: 'project', label: 'Kanban', path: '/kanban' } satisfies SidebarNavContribution
      },
      {
        id: 'count',
        area: STATUSBAR_AREAS.right,
        order: 80,
        render: () => <KanbanCount />
      },
      {
        id: 'open',
        area: PALETTE_AREA,
        data: {
          id: 'kanban.open',
          label: 'Kanban: Open board',
          keywords: ['kanban', 'board', 'tasks', 'agents'],
          run: () => host.navigate('/kanban')
        } satisfies PaletteContribution
      }
    ])
  }
}

export default plugin
