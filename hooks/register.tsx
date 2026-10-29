import { atom, read } from 'claude-code'
import type { EngineInterface, Register, Timer } from 'claude-code'

import type { OfficeAgent, OfficeKind } from '../types'
import { MIN_SCENE_ROWS, Office, cellSafe, clip } from './scene'

const PANE = 'oficina'
const SCENE = 'escena'
const TICK_MS = 90
const POLL_EVERY = 20 // ticks, about two seconds
const CLOSE_AFTER = 40 // quiet ticks before the office closes itself
const WIDTH_SHARE = 0.35
const LIST_MAX = 6
// The list under the scene always takes this many rows, so an arrival never
// resizes the scene (a resize skips everyone's walk).
const LIST_ROWS = LIST_MAX + 2
// Off the terminal the scene is an Svg drawn whole on every frame; this keeps
// its markup well under the element's 131072 characters.
const SVG_MAX_COLUMNS = 120
const SVG_MAX_ROWS = 40
const LIST_GRACE_MS = 10_000 // how long a new agent may be missing from $.agent.list()
const WORKFLOW_SILENCE_MS = 15 * 60_000 // a workflow agent this quiet has ended unseen

const agentsRef = { plugin: 'oficina', key: 'agents' } as const
const agents = atom(agentsRef, [] as OfficeAgent[])
const autoRef = { plugin: 'oficina', key: 'isAutoOpened' } as const
const isAutoOpened = atom(autoRef, false)

// The animation lives here; what the list under it reads lives in $.state.
const office = new Office()
const lastSeen = new Map<string, number>()
// Agents ended by silence alone, who come back if they show signs of life.
const silenced = new Set<string>()
let terminalColumns = 0
let isFullscreen: boolean | undefined
let mounted: { columns: number; rows: number } | undefined
// A surface without Raster draws the pane: each tick redraws it, no blit there.
let isDrawnAsSvg = false
let isDismissed = false
let isDirty = false
let isPolling = false
let hasHinted = false
let quietTicks = 0
let ticks = 0
let batch = 0
let ticker: Timer | undefined

// The engine's word on the pane, never a guess kept here.
async function paneNow($: EngineInterface): Promise<{ isOpen: boolean; isPlaced: boolean; isShown: boolean }> {
  const pane = (await $.ui.panes()).find(one => one.id === PANE)

  return { isOpen: pane !== undefined, isPlaced: pane?.isPlaced ?? false, isShown: pane?.isShown ?? false }
}

function paneColumns(): number | undefined {
  return terminalColumns > 0 ? Math.max(30, Math.round(terminalColumns * WIDTH_SHARE)) : undefined
}

async function openPane($: EngineInterface, isAsked: boolean): Promise<boolean> {
  const columns = paneColumns()
  const opened = await $.ui.open({
    id: PANE,
    title: 'Oficina',
    rows: MIN_SCENE_ROWS + LIST_ROWS,
    ...(columns ? { columns } : {}),
    ...(isAsked ? { focus: true as const } : {}),
  })
  await $.state.set(autoRef, !isAsked)

  return opened.isPlaced
}

async function closePane($: EngineInterface): Promise<void> {
  mounted = undefined
  isDrawnAsSvg = false
  await $.state.set(autoRef, false)
  await $.ui.close({ id: PANE })
}

async function flush($: EngineInterface): Promise<void> {
  isDirty = false
  await $.state.set(agentsRef, office.list())
}

function startTicking($: EngineInterface): void {
  quietTicks = 0
  if (ticker) return
  ticker = $.clock.every(TICK_MS, () => void tick($))
}

function stopTicking(): void {
  ticker?.cancel()
  ticker = undefined
}

async function tick($: EngineInterface): Promise<void> {
  ticks++
  office.step()
  // About once a second, so the list's running times move.
  if (ticks % 11 === 0 && office.counts().working > 0) isDirty = true
  if (isDirty) void flush($)
  if (ticks % POLL_EVERY === 0) void poll($)

  if (office.isBusy) quietTicks = 0
  else if (++quietTicks >= CLOSE_AFTER) return endBatch($)

  // The engine folds these to ten redraws a second.
  if (isDrawnAsSvg) $.ui.invalidate('ui.render')

  const drawn = mounted
  if (drawn) {
    const { columns, rows } = drawn
    const blit = await $.ui.blit({ requestId: PANE, key: SCENE, cells: office.cells(columns, rows), columns, rows })
    // Not drawn any more (closed, refused, resized): wait for the next render,
    // unless one has already come.
    if (blit.deny && mounted === drawn) mounted = undefined
  }
}

// Everyone left: the office closes if it opened by itself, and empties.
async function endBatch($: EngineInterface): Promise<void> {
  stopTicking()
  const ending = batch
  // Someone may arrive during any await here; then the batch goes on.
  const isStale = () => batch !== ending || office.isBusy
  const wasAutoOpened = await read($, isAutoOpened)
  if (isStale()) return startTicking($)

  office.clear()
  lastSeen.clear()
  silenced.clear()
  isDismissed = false
  hasHinted = false
  $.ui.status(undefined)
  await flush($)
  if (!wasAutoOpened || isStale()) return
  const pane = await paneNow($)
  if (pane.isOpen && !isStale()) await closePane($)
}

// A backstop for ends no turn.complete told of: a stopped agent, one the
// list dropped, a workflow agent that went silent.
async function poll($: EngineInterface): Promise<void> {
  if (isPolling) return
  isPolling = true
  try {
    const asked = Date.now()
    const listed = new Map((await $.agent.list()).map(info => [info.id, info.status] as const))
    const now = Date.now()
    for (const one of office.list()) {
      if (one.status === 'done' || one.status === 'failed') continue
      // Heard from since the list was asked for (a resume, say): the list is stale for it.
      if ((lastSeen.get(one.id) ?? 0) >= asked) continue
      const status = listed.get(one.id)
      // A teammate in a terminal pane of its own raises no turns here: the list says.
      if (one.kind === 'teammate' && (status === 'idle' || status === 'waiting') && one.status === 'working') {
        if (office.patch(one.id, { status: 'idle', activity: undefined })) isDirty = true
        continue
      }
      if (one.kind === 'teammate' && status === 'running' && one.status === 'idle') {
        if (office.patch(one.id, { status: 'working' })) isDirty = true
        continue
      }
      if (status === 'completed') end(one.id, 'done')
      else if (status === 'failed' || status === 'killed') end(one.id, 'failed')
      else if (one.kind === 'workflow') {
        if (now - (lastSeen.get(one.id) ?? one.startedAt) > WORKFLOW_SILENCE_MS) {
          end(one.id, 'done')
          silenced.add(one.id)
        }
      } else if (status === undefined && now - one.startedAt > LIST_GRACE_MS) end(one.id, 'done')
    }
  } finally {
    isPolling = false
  }
}

function end(id: string, status: 'done' | 'failed'): void {
  lastSeen.delete(id)
  silenced.delete(id)
  if (office.patch(id, { status, endedAt: Date.now(), activity: undefined })) isDirty = true
}

function seen(id: string): void {
  lastSeen.set(id, Date.now())
}

// An agent ended by silence alone that shows activity is back at work.
function revive($: EngineInterface, id: string): void {
  if (!silenced.delete(id)) return
  office.patch(id, { status: 'working', endedAt: undefined })
  isDirty = true
  startTicking($)
}

async function arrive($: EngineInterface, agent: OfficeAgent): Promise<void> {
  const isNewBatch = !office.isBusy
  if (isNewBatch) {
    batch++
    isDismissed = false
    hasHinted = false
  }
  office.upsert(agent)
  seen(agent.id)
  isDirty = true
  startTicking($)

  const pane = await paneNow($)
  if (pane.isOpen || isDismissed) return
  // A side strip needs the fullscreen layout; elsewhere a pane would sit
  // above the prompt, so it waits for /oficina.
  if (isFullscreen === true && (await openPane($, false))) return
  if (!hasHinted) {
    hasHinted = true
    $.ui.status('🏢 Agentes trabajando · /oficina para ver la oficina')
  }
}

// What a tool call reads as, in a few words.
function describe(e: { tool: string } & Record<string, unknown>): string {
  const text = (key: string) => (typeof e[key] === 'string' ? (e[key] as string) : '')
  const file = (key: string) => text(key).split('/').filter(Boolean).pop() ?? ''
  const tool = String(e.tool)
  switch (tool) {
    case 'Read':
      return `lee ${file('file_path')}`
    case 'Edit':
    case 'MultiEdit':
      return `edita ${file('file_path')}`
    case 'Write':
      return `escribe ${file('file_path')}`
    case 'NotebookEdit':
      return `edita ${file('notebook_path')}`
    case 'Bash':
      return `$ ${text('command').split('\n')[0] ?? ''}`
    case 'Grep':
      return `busca "${text('pattern')}"`
    case 'Glob':
      return `busca ${text('pattern')}`
    case 'WebFetch':
      return `abre ${text('url').replace(/^https?:\/\//, '')}`
    case 'WebSearch':
      return `googlea ${text('query')}`
    case 'Agent':
    case 'Task':
      return `delega ${text('description')}`
    case 'TodoWrite':
      return 'ordena pendientes'
    default:
      return tool.startsWith('mcp__') ? tool.split('__').slice(2).join(' ') : tool
  }
}

function kindOf(e: { isTeammate?: true; workflow?: unknown }): OfficeKind {
  return e.isTeammate ? 'teammate' : e.workflow ? 'workflow' : 'subagent'
}

function elapsed(agent: OfficeAgent): string {
  const ms = (agent.endedAt ?? Date.now()) - agent.startedAt
  const s = Math.max(0, Math.round(ms / 1000))

  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'oficina',
      description: 'Abre o cierra la oficina de agentes; "/oficina limpiar" la vacía',
      argumentHint: '[limpiar]',
      immediate: true,
    })
    // A reload keeps $.state and the pane: whoever was at work sits back down,
    // and the ticker runs to animate them or to close up after them.
    const kept = await read($, agents)
    office.restore(kept)
    for (const one of kept) if (one.status === 'working' || one.status === 'idle') seen(one.id)
    if (kept.length > 0 || (await read($, isAutoOpened))) {
      batch++
      startTicking($)
    }

    return next(e)
  })

  on('command.run', { command: 'oficina' }, async ($, e) => {
    terminalColumns = e.presentation.columns > 0 ? e.presentation.columns : terminalColumns
    isFullscreen = e.presentation.isFullscreen
    const pane = await paneNow($)

    if (e.args.trim() === 'limpiar') {
      stopTicking()
      office.clear()
      lastSeen.clear()
      silenced.clear()
      isDismissed = false
      hasHinted = false
      $.ui.status(undefined)
      await flush($)
      if (pane.isOpen && (await read($, isAutoOpened))) await closePane($)

      return { text: 'Oficina vaciada.' }
    }
    if (pane.isOpen && pane.isPlaced && pane.isShown) {
      isDismissed = office.isBusy
      await closePane($)

      return { text: 'Oficina cerrada.' }
    }
    isDismissed = false
    $.ui.status(undefined)
    await openPane($, true)
    startTicking($)

    return { text: 'Oficina abierta.' }
  })

  on('ui.close', async ($, e, next) => {
    const result = await next(e)
    if (e.id === PANE) {
      mounted = undefined
      isDrawnAsSvg = false
      if (e.origin.kind === 'person' && office.isBusy) isDismissed = true
    }

    return result
  }).catch(($, e, next) => next(e))

  on('agent.spawn', async ($, e, next) => {
    const result = await next(e)
    const id = e.resume?.agentId ?? ('agentId' in result ? result.agentId : undefined)
    if (!id || result.deny) return result

    const known = office.get(id)
    const label =
      e.description.trim() || (e.workflow ? `agente ${e.workflow.agentIndex}` : e.subagentType || 'agente')
    void arrive($, {
      id,
      label: known?.label ?? label,
      kind: kindOf(e),
      status: 'working',
      startedAt: known?.startedAt ?? Date.now(),
    })

    return result
  }).catch(($, e, next) => next(e))

  on('turn.start', async ($, e, next) => {
    const id = e.agentId
    if (!id) return next(e)
    seen(id)
    revive($, id)
    const one = office.get(id)
    if (one?.status === 'idle') {
      office.patch(id, { status: 'working' })
      isDirty = true
      startTicking($)
    } else if (!one) {
      // A teammate waking after the office emptied comes back in.
      const info = (await $.agent.list()).find(a => a.id === id)
      if (info?.teammateId) {
        void arrive($, { id, label: info.description || info.name || 'compañero', kind: 'teammate', status: 'working', startedAt: Date.now() })
      }
    }

    return next(e)
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    const one = e.agentId ? office.get(e.agentId) : undefined
    if (one && e.agentId) {
      // A teammate's turn ends in a nap; it leaves when the list says it ended.
      if (one.kind === 'teammate') office.patch(e.agentId, { status: 'idle', activity: undefined })
      else end(e.agentId, e.reason === 'answer' ? 'done' : 'failed')
      isDirty = true
    }

    return result
  }).catch(($, e, next) => next(e))

  on('tool.call', async ($, e, next) => {
    if (e.agentId) revive($, e.agentId)
    if (e.agentId && office.get(e.agentId)?.status === 'working') {
      seen(e.agentId)
      const activity = clip(cellSafe(describe(e as { tool: string } & Record<string, unknown>)), 60)
      if (office.patch(e.agentId, { activity })) isDirty = true
    }

    return next(e)
  }).catch(($, e, next) => next(e))

  // Only to learn the terminal's width and layout before the pane first opens.
  on('ui.render', { component: 'PromptHint' }, ($, e, next) => {
    if (e.surface === 'terminal' && e.viewport) {
      if (e.viewport.columns > 0) terminalColumns = e.viewport.columns
      if (e.viewport.isFullscreen !== undefined) isFullscreen = e.viewport.isFullscreen
    }

    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const list = await read($, agents)
    const columns = Math.min(512, Math.max(20, e.props.bodyColumns))
    const shown = [
      ...list.filter(a => a.status === 'working' || a.status === 'idle'),
      ...list.filter(a => a.status === 'done' || a.status === 'failed').reverse(),
    ]
    const lines = shown.slice(0, shown.length > LIST_MAX ? LIST_MAX - 1 : LIST_MAX)
    const hidden = shown.length - lines.length

    if (e.surface !== 'terminal') {
      const { Box, Text, Svg } = $.ui.resolve(e)
      const sceneColumns = Math.min(SVG_MAX_COLUMNS, columns)
      const sceneRows = Math.min(SVG_MAX_ROWS, Math.max(MIN_SCENE_ROWS, e.props.scroll.bodyRows - LIST_ROWS))
      const n = office.counts()
      isDrawnAsSvg = true

      return (
        <Box flexDirection="column">
          <Svg
            source={office.svg(sceneColumns, sceneRows)}
            alt={`Oficina: ${n.working} trabajando, ${n.done} listas${n.failed > 0 ? `, ${n.failed} fallidas` : ''}`}
          />
          {shown.length === 0 && <Text dimColor>Nadie trabajando ahora.</Text>}
          {shown.map(a => (
            <Text>
              {a.status === 'done' ? '✓' : a.status === 'failed' ? '✗' : '●'} {a.label}
            </Text>
          ))}
        </Box>
      )
    }

    const { Box, Text, Raster } = $.ui.resolve(e)
    const rows = Math.min(256, Math.max(MIN_SCENE_ROWS, e.props.scroll.bodyRows - LIST_ROWS))
    mounted = { columns, rows }
    const nameWidth = Math.max(8, Math.min(32, columns - 24))

    return (
      <Box flexDirection="column">
        <Raster key={SCENE} columns={columns} rows={rows} cells={office.cells(columns, rows)} />
        <Box flexDirection="column" paddingLeft={1} paddingTop={1} height={LIST_ROWS}>
          {lines.length === 0 && <Text dimColor>Nadie trabajando ahora.</Text>}
          {lines.map(a => (
            <Box flexDirection="row">
              <Text color={a.status === 'done' ? 'success' : a.status === 'failed' ? 'error' : a.status === 'idle' ? 'suggestion' : 'claude'}>
                {a.status === 'done' ? '✓ ' : a.status === 'failed' ? '✗ ' : a.status === 'idle' ? 'z ' : '● '}
              </Text>
              <Text bold={a.status === 'working'}>{clip(a.label, nameWidth)}</Text>
              <Text dimColor>
                {'  '}
                {a.status === 'working' && a.activity ? clip(a.activity, Math.max(0, columns - nameWidth - 14)) + ' · ' : ''}
                {elapsed(a)}
              </Text>
            </Box>
          ))}
          {hidden > 0 && <Text dimColor>+{hidden} más</Text>}
        </Box>
      </Box>
    )
  })
}
