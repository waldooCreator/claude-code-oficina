import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import type { Engine } from 'claude-code/testing'

const AGENTS = { plugin: 'oficina', key: 'agents' } as const

type Seen = { id: string; status: string; label: string; kind: string }
type Log = { opens: unknown[]; closes: unknown[]; blits: { columns?: number; rows?: number }[]; writes: Seen[][]; status: (string | undefined)[] }

// The engine beneath the plugin: what each op the mod calls answers.
type OpenAnswer = { isPlaced: true } | { isPlaced: false; reason: string }

function engine(on: On, log: Log, answerOpen: (n: number) => OpenAnswer = () => ({ isPlaced: true })): void {
  // The one pane, as the engine would list it.
  let pane: { id: string; title: string; isShown: boolean; isFocused: boolean; isPlaced: boolean } | undefined
  on('agent.spawn', () => ({ model: 'claude-test', agentId: 'agent-1' }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('ui.open', ($, e) => {
    log.opens.push(e)
    const answer = answerOpen(log.opens.length)
    pane = { id: e.id, title: e.title ?? e.id, isShown: answer.isPlaced, isFocused: false, isPlaced: answer.isPlaced }
    return { value: answer }
  })
  on('ui.close', ($, e) => {
    log.closes.push(e)
    pane = undefined
    return { value: undefined }
  })
  on('ui.panes', () => ({ value: pane ? [pane] : [] }))
  // The engine's own prompt hint, beneath the mod's observer.
  on('ui.render', { component: 'PromptHint' }, ($, e) => {
    const { Text } = $.ui.resolve(e)
    return h(Text, null, e.props.hint) as never
  })
  on('ui.status', ($, e) => {
    log.status.push((e as { text?: string }).text)
    return { value: undefined }
  })
  on('ui.blit', ($, e) => {
    log.blits.push({ columns: (e as { columns?: number }).columns, rows: (e as { rows?: number }).rows })
    return { value: {} }
  })
  on('agent.list', () => ({ value: [] }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  // The engine's $ has no state noun: watch the writes on their way to the kit.
  on('state.set', async ($, e, next) => {
    const w = e as { plugin: string; key: string; value: unknown }
    if (w.plugin === AGENTS.plugin && w.key === AGENTS.key) log.writes.push(w.value as Seen[])
    return next(e)
  })
}

const SPAWN = {
  tool_use_id: 'toolu_1',
  prompt: 'Revisa el modulo',
  description: 'Revisar modulo',
  subagentType: 'general-purpose',
  provider: { plugin: 'engine', tier: 'core' as const },
  parentModel: 'claude-test',
  background: false,
  fork: false,
}

const DONE = {
  answer: 'listo',
  durationMs: 1200,
  isAborted: false,
  turnId: 'turn-1',
  agentId: 'agent-1',
  reason: 'answer' as const,
}

// The mod learns the terminal's layout from the prompt hint's drawing.
async function terminal($: Engine, isFullscreen: boolean, columns = 200): Promise<void> {
  const hint = await $.ui.mount({
    plugin: 'oficina',
    surface: 'terminal',
    component: 'PromptHint',
    requestId: 'hint',
    props: { isDraft: false, isWorking: true, hint: '? for shortcuts' },
    viewport: { columns, rows: 50, isFullscreen },
  } as never)
  await hint.drawn()
  await hint.unmount()
}

function agentsNow(log: Log): Seen[] {
  return log.writes.at(-1) ?? []
}

test('agent.spawn seats a working agent, turn.complete marks it done', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000 })
  const log: Log = { opens: [], closes: [], blits: [], writes: [], status: [] }
  engine(on, log)
  await terminal($, true)

  const spawned = await $.agent.spawn(SPAWN as never)
  expect(spawned).toMatchObject({ agentId: 'agent-1' })
  await clock.advance(90)

  const afterSpawn = agentsNow(log)
  expect(afterSpawn).toHaveLength(1)
  expect(afterSpawn[0]).toMatchObject({ id: 'agent-1', status: 'working', label: 'Revisar modulo', kind: 'subagent' })
  expect(log.opens).toHaveLength(1)
  expect(log.opens[0]).toMatchObject({ id: 'oficina' })

  await $.turn.complete(DONE as never)
  await clock.advance(90)

  const afterDone = agentsNow(log)
  expect(afterDone[0]).toMatchObject({ id: 'agent-1', status: 'done' })
})

test('the auto-opened office closes itself once everyone has left', { timeoutMs: 20_000 }, async ($, on) => {
  const clock = mock.clock(on, { now: 1_000 })
  const log: Log = { opens: [], closes: [], blits: [], writes: [], status: [] }
  engine(on, log)
  await terminal($, true)

  await $.agent.spawn(SPAWN as never)
  await clock.advance(90)
  await $.turn.complete(DONE as never)
  // Cheer, walk out, fade, then CLOSE_AFTER quiet ticks.
  for (let i = 0; i < 400 && log.closes.length === 0; i++) await clock.advance(90)

  expect(log.closes).toHaveLength(1)
  expect(log.closes[0]).toMatchObject({ id: 'oficina' })
  expect(agentsNow(log)).toHaveLength(0)
})

for (const surface of ['terminal', 'desktop'] as const) {
  test(`the Pane draws on ${surface} without refusal`, async ($, on) => {
    const clock = mock.clock(on, { now: 1_000 })
    const log: Log = { opens: [], closes: [], blits: [], writes: [], status: [] }
    engine(on, log)
    await terminal($, true)

    await $.agent.spawn(SPAWN as never)
    await clock.advance(90)

    const ui = await $.ui.mount({
      plugin: 'oficina',
      surface,
      component: 'Pane',
      requestId: 'oficina',
      props: {
        title: 'Oficina',
        isFocused: false,
        bodyColumns: 48,
        placement: 'dock',
        scroll: { offset: 0, bodyRows: 40 },
        view: {},
      },
      viewport: { columns: 140, rows: 45, isFullscreen: true },
    })
    const tree = await ui.drawn()
    expect(tree).toMatchObject({ type: 'Box' })

    if (surface === 'terminal') {
      const raster = await ui.find({ type: 'Raster', key: 'escena' })
      expect(raster).toBeDefined()
      const props = raster!.props as { columns: number; rows: number; cells: string }
      expect(props.columns).toBe(48)
      expect(props.rows).toBeGreaterThanOrEqual(19)
      // columns * rows cells of three u32 each, base64 padded.
      expect(props.cells.length).toBe(Math.ceil((props.columns * props.rows * 12) / 3) * 4)

      // The next tick repaints the mounted Raster by blit.
      await clock.advance(90)
      expect(log.blits.length).toBeGreaterThan(0)
      expect(log.blits.at(-1)).toMatchObject({ columns: 48, rows: props.rows })
    }
    expect(await ui.find({ text: /Revisar modulo/ })).toBeDefined()
    await ui.unmount()
  })
}

test('a second batch of agents opens the office again after it closed itself', { timeoutMs: 20_000 }, async ($, on) => {
  const clock = mock.clock(on, { now: 1_000 })
  const log: Log = { opens: [], closes: [], blits: [], writes: [], status: [] }
  engine(on, log)
  await terminal($, true)

  await $.agent.spawn(SPAWN as never)
  await clock.advance(90)
  await $.turn.complete(DONE as never)
  for (let i = 0; i < 400 && log.closes.length === 0; i++) await clock.advance(90)
  expect(log.closes).toHaveLength(1)

  await $.agent.spawn(SPAWN as never)
  await clock.advance(90)
  expect(log.opens, 'the second spawn should auto-open the pane again').toHaveLength(2)
})

test('/oficina toggles: open, close, open', async ($, on) => {
  mock.clock(on, { now: 1_000 })
  const log: Log = { opens: [], closes: [], blits: [], writes: [], status: [] }
  engine(on, log)

  const first = await $.command.run({ command: 'oficina', args: '', presentation: { isFullscreen: true, columns: 160 } } as never)
  const second = await $.command.run({ command: 'oficina', args: '', presentation: { isFullscreen: true, columns: 160 } } as never)
  const third = await $.command.run({ command: 'oficina', args: '', presentation: { isFullscreen: true, columns: 160 } } as never)
  expect([first, second, third].map(r => (r as { text?: string }).text)).toEqual([
    'Oficina abierta.',
    'Oficina cerrada.',
    'Oficina abierta.',
  ])
})

test('after the office closed itself, /oficina opens it (one command, not two)', { timeoutMs: 20_000 }, async ($, on) => {
  const clock = mock.clock(on, { now: 1_000 })
  const log: Log = { opens: [], closes: [], blits: [], writes: [], status: [] }
  engine(on, log)
  await terminal($, true)

  await $.agent.spawn(SPAWN as never)
  await clock.advance(90)
  await $.turn.complete(DONE as never)
  for (let i = 0; i < 400 && log.closes.length === 0; i++) await clock.advance(90)
  const run = { command: 'oficina', args: '', presentation: { isFullscreen: true, columns: 160 } }
  const r = (await $.command.run(run as never)) as { text?: string }
  expect(r.text).toBe('Oficina abierta.')
})

test('main screen: no pane opens by itself, a status line points to /oficina, which opens it', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000 })
  const log: Log = { opens: [], closes: [], blits: [], writes: [], status: [] }
  engine(on, log)
  await terminal($, false, 120)

  await $.agent.spawn(SPAWN as never)
  await clock.advance(90)
  expect(log.opens).toHaveLength(0)
  expect(log.status.at(-1)).toMatch(/oficina/)
  const run = { command: 'oficina', args: '', presentation: { isFullscreen: false, columns: 120 } }
  const r = (await $.command.run(run as never)) as { text?: string }
  expect(r.text).toBe('Oficina abierta.')
  expect(log.opens).toHaveLength(1)
  expect(log.closes).toHaveLength(0)
})

test('narrow fullscreen terminal: an unplaced auto-open, then /oficina places it instead of closing it', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000 })
  const log: Log = { opens: [], closes: [], blits: [], writes: [], status: [] }
  engine(on, log, n => (n === 1 ? { isPlaced: false, reason: 'opened unasked below 144 columns (120 now)' } : { isPlaced: true }))
  await terminal($, true, 120)

  await $.agent.spawn(SPAWN as never)
  await clock.advance(90)
  expect(log.opens).toHaveLength(1)
  const run = { command: 'oficina', args: '', presentation: { isFullscreen: true, columns: 120 } }
  const r = (await $.command.run(run as never)) as { text?: string }
  expect(r.text).toBe('Oficina abierta.')
  expect(log.opens).toHaveLength(2)
  expect(log.closes).toHaveLength(0)
})

for (const [cols, bodyRows] of [[20, 5], [48, 40], [200, 80]] as const) {
  test(`terminal Raster stays valid with an emoji label at ${cols}x${bodyRows}`, async ($, on) => {
    const clock = mock.clock(on, { now: 1_000 })
    const log: Log = { opens: [], closes: [], blits: [], writes: [], status: [] }
    engine(on, log)
    await terminal($, true)
    await $.agent.spawn({ ...SPAWN, description: '🚀 Revisar módulo 日本語 é' } as never)
    for (let i = 0; i < 30; i++) await clock.advance(90)
    const ui = await $.ui.mount({
      plugin: 'oficina',
      surface: 'terminal',
      component: 'Pane',
      requestId: 'oficina',
      props: { title: 'Oficina', isFocused: false, bodyColumns: cols, placement: 'dock', scroll: { offset: 0, bodyRows }, view: {} },
      viewport: { columns: 160, rows: 50, isFullscreen: true },
    })
    await ui.drawn()
    await clock.advance(90)
    await ui.drawn()
    await ui.unmount()
  })
}
