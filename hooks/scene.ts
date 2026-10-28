// The office scene: a pixel buffer two pixels per terminal cell (the upper
// half block's foreground on top, its background below), so pixels are
// square. Pure code, no `$`: the hooks module drives it and blits its cells.

import type { OfficeAgent } from '../types'

// Colors, 0xRRGGBB.
const C = {
  header: 0x1b1924,
  headerText: 0xf0e6d8,
  headerDim: 0x9a93a8,
  wall: 0x2e2b3a,
  wallStripe: 0x332f42,
  wainscot: 0x3d3850,
  wainscotTrim: 0x4a4462,
  baseboard: 0x1f1c29,
  plankA: 0x5b3f2c,
  plankB: 0x634532,
  seam: 0x4a3324,
  floorShadow: 0x47311f,
  clawd: 0xd97757,
  clawdLight: 0xf0a07f,
  clawdDark: 0xb5603f,
  eye: 0x2a1a14,
  eyeClosed: 0x8c3f2b,
  deskTop: 0xc8935a,
  deskEdge: 0xa87445,
  deskFront: 0x8a5a36,
  deskLeg: 0x5a3a22,
  nameText: 0xf3e3c3,
  chair: 0x3e4152,
  chairHi: 0x4d5166,
  laptop: 0xa9afb8,
  laptopDark: 0x7d838c,
  doorFrame: 0x6b4a2f,
  doorLeaf: 0x8b5e3c,
  doorPanel: 0x7a5233,
  doorGlass: 0x3a5570,
  knob: 0xe8c15a,
  dark: 0x0e0d12,
  exitBg: 0x1e3a28,
  exitText: 0x7cfc9a,
  windowFrame: 0xd8cfc0,
  sky: 0x1c2a4a,
  star: 0xfff4c2,
  starDim: 0x8a8670,
  frame: 0xe9dcc5,
  canvas: 0xf5ede0,
  pot: 0xb5603f,
  leaf: 0x5fa35f,
  leafDark: 0x3f7a45,
  ok: 0x7bd88f,
  fail: 0xff6b6b,
  activity: 0xd8cfe8,
  zzz: 0x9ab4ff,
  spark: 0xffd76a,
}

// Geometry in pixels. Every y a text row sits on is even.
const WALL_TOP = 2
const FLOOR_TOP = 14
const CORRIDOR_Y = 15 // a walking Clawd's top on the corridor
const GRID_TOP = 22
const STATION_W = 24
const STATION_H = 14
const DOOR_W = 20
const DOOR_H = 10
const DOOR_Y = 4
const DOOR_LEAF = DOOR_W / 2
const DOOR_OPEN = DOOR_LEAF - 1
const SPRITE_W = 16
const SPRITE_H = 5

// The fewest terminal rows that hold the header, the wall, the corridor and
// one row of desks.
export const MIN_SCENE_ROWS = (GRID_TOP + STATION_H) / 2 + 1

// Clawd, 16x5: `#` body, `e` eye, `l` leg.
const CLAWD = {
  stand: ['..############..', '..##e######e##..', '################', '..############..', '...l.l....l.l...'],
  walk: ['..############..', '..##e######e##..', '################', '..############..', '..l.l......l.l..'],
  typeLeft: ['..############..', '..##e######e##..', '..##############', '##############..', '...l.l....l.l...'],
  typeRight: ['..############..', '..##e######e##..', '##############..', '..##############', '...l.l....l.l...'],
  cheer: ['#.############.#', '#.##e######e##.#', '..############..', '..############..', '...l.l....l.l...'],
}

type Frame = keyof typeof CLAWD
type Eyes = 'open' | 'closed'

// The Claude starburst for the painting on the wall, 7x7.
const STARBURST = ['...#...', '.#.#.#.', '..###..', '#######', '..###..', '.#.#.#.', '...#...']

type Phase =
  | 'queued' // waiting for the doorway to clear
  | 'arriving' // fading in inside the doorway
  | 'walking-in'
  | 'seated'
  | 'cheer'
  | 'walking-out'
  | 'leaving' // fading out inside the doorway
  | 'gone'

type Point = { x: number; y: number }

type Actor = {
  id: string
  slot: number
  phase: Phase
  x: number
  y: number
  t: number
  fade: number // 0 hidden in the dark, 1 fully lit
  path: Point[]
  blinkAt: number
}

type Layout = {
  W: number
  H: number
  rows: number
  gridCols: number
  gridRows: number
  gridLeft: number
  capacity: number
  doorX: number
}

type TextRun = { col: number; row: number; text: string; fg: number; bg?: number }

const FADE_STEPS = 6
const CHEER_TICKS = 18
const LINGER_TICKS = 3

function layoutFor(columns: number, rows: number): Layout {
  const W = columns
  const H = rows * 2
  const gridCols = Math.max(1, Math.floor((W - 2) / STATION_W))
  const gridRows = Math.max(1, Math.floor((H - GRID_TOP) / STATION_H))
  const gridLeft = Math.max(0, Math.floor((W - gridCols * STATION_W) / 2))
  const doorX = Math.max(0, W - DOOR_W - 2)

  return { W, H, rows, gridCols, gridRows, gridLeft, capacity: gridCols * gridRows, doorX }
}

function mix(a: number, b: number, t: number): number {
  const ch = (shift: number) => {
    const x = (a >> shift) & 0xff
    const y = (b >> shift) & 0xff

    return Math.round(x + (y - x) * t) << shift
  }

  return ch(16) | ch(8) | ch(0)
}

// The symbols drawn beside the scripts below, each one cell wide everywhere.
const NARROW_SYMBOLS = new Set([...'–—‘’‚“”„•…‹›€™←↑→↓✓✗●○◌✦·'])

// What a terminal cell can hold: one printable, width-1 BMP character. An
// allow-list, since one wide or zero-width character gets the tree refused.
export function cellSafe(text: string): string {
  let out = ''
  for (const ch of text.normalize('NFC')) {
    const cp = ch.codePointAt(0) ?? 0x3f
    const isAllowed =
      (cp >= 0x20 && cp <= 0x7e) || // ASCII
      (cp >= 0xa1 && cp <= 0x24f && cp !== 0xad) || // Latin-1 and Latin Extended
      (cp >= 0x370 && cp <= 0x3ff && cp !== 0x37a) || // Greek
      (cp >= 0x400 && cp <= 0x482) || // Cyrillic, less its combining marks
      (cp >= 0x48a && cp <= 0x4ff) ||
      (cp >= 0x1e00 && cp <= 0x1eff) || // Latin Extended Additional
      NARROW_SYMBOLS.has(ch)
    out += isAllowed ? ch : '?'
  }

  return out
}

export function clip(text: string, width: number): string {
  if (width <= 0) return ''
  const chars = [...text]

  return chars.length <= width ? text : chars.slice(0, Math.max(0, width - 1)).join('') + '…'
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

export function toBase64(bytes: Uint8Array): string {
  let out = ''
  let i = 0
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8) | bytes[i + 2]!
    out += B64[(n >> 18) & 63]! + B64[(n >> 12) & 63]! + B64[(n >> 6) & 63]! + B64[n & 63]!
  }
  const rest = bytes.length - i
  if (rest === 1) {
    const n = bytes[i]! << 16
    out += B64[(n >> 18) & 63]! + B64[(n >> 12) & 63]! + '=='
  } else if (rest === 2) {
    const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8)
    out += B64[(n >> 18) & 63]! + B64[(n >> 12) & 63]! + B64[(n >> 6) & 63]! + '='
  }

  return out
}

export class Office {
  private agents = new Map<string, OfficeAgent>()
  private order: string[] = []
  private actors = new Map<string, Actor>()
  private slots: (string | null)[] = []
  private L: Layout = layoutFor(60, 30)
  private tick = 0
  private door = 0
  private doorIdle = 0

  // The agents, oldest first.
  list(): OfficeAgent[] {
    return this.order.flatMap(id => {
      const one = this.agents.get(id)

      return one ? [one] : []
    })
  }

  has(id: string): boolean {
    return this.agents.has(id)
  }

  get(id: string): OfficeAgent | undefined {
    return this.agents.get(id)
  }

  // An agent arrives, or one that ended comes back to work.
  upsert(agent: OfficeAgent): void {
    if (!this.agents.has(agent.id)) this.order.push(agent.id)
    this.agents.set(agent.id, agent)
    const actor = this.actors.get(agent.id)
    if (actor && actor.phase === 'gone' && (agent.status === 'working' || agent.status === 'idle')) {
      this.actors.delete(agent.id)
      this.slots = this.slots.map(one => (one === agent.id ? null : one))
    }
  }

  patch(id: string, change: Partial<OfficeAgent>): boolean {
    const one = this.agents.get(id)
    if (!one) return false
    const next: OfficeAgent = { ...one, ...change }
    if (next.activity === undefined) delete next.activity
    if (next.endedAt === undefined) delete next.endedAt
    const isSame = JSON.stringify(next) === JSON.stringify(one)
    this.agents.set(id, next)

    return !isSame
  }

  // After a reload: everyone is listed again, and those still at work sit at
  // their desks at once.
  restore(list: readonly OfficeAgent[]): void {
    this.clear()
    for (const agent of list) {
      this.upsert(agent)
      if (agent.status !== 'working' && agent.status !== 'idle') continue
      const slot = this.freeSlot()
      if (slot === undefined) continue
      this.slots[slot] = agent.id
      this.actors.set(agent.id, this.seatedActor(agent.id, slot))
    }
  }

  clear(): void {
    this.agents.clear()
    this.order = []
    this.actors.clear()
    this.slots = []
    this.door = 0
  }

  // True while anyone works, a teammate waits for its next message, or
  // someone is still on screen.
  get isBusy(): boolean {
    for (const agent of this.agents.values()) {
      if (agent.status === 'working' || agent.status === 'idle') return true
    }
    for (const actor of this.actors.values()) {
      if (actor.phase !== 'gone') return true
    }

    return false
  }

  counts(): { working: number; idle: number; done: number; failed: number; queued: number } {
    const out = { working: 0, idle: 0, done: 0, failed: 0, queued: 0 }
    for (const agent of this.agents.values()) {
      out[agent.status]++
      if (agent.status === 'working' && !this.actors.has(agent.id)) out.queued++
    }

    return out
  }

  // One step of the animation.
  step(): void {
    this.tick++
    this.seatNewcomers()
    for (const actor of this.actors.values()) this.advance(actor)
    this.moveDoor()
  }

  // The scene as Raster cells, `columns * rows`, base64 as RasterProps packs them.
  cells(columns: number, rows: number): string {
    this.resize(columns, rows)
    const { W, H } = this.L
    const px = new Uint32Array(W * H)
    const texts: TextRun[] = []
    this.paint(px, texts)

    const words = new Uint32Array(W * rows * 3)
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < W; c++) {
        const top = px[2 * r * W + c]!
        const bottom = px[(2 * r + 1) * W + c]!
        const at = (r * W + c) * 3
        words[at] = top === bottom ? 0x20 : 0x2580
        words[at + 1] = top
        words[at + 2] = bottom
      }
    }
    for (const run of texts) {
      if (run.row < 0 || run.row >= rows) continue
      let col = run.col
      for (const ch of run.text) {
        if (col >= W) break
        if (col >= 0) {
          const at = (run.row * W + col) * 3
          words[at] = ch.codePointAt(0) ?? 0x3f
          words[at + 1] = run.fg
          words[at + 2] = run.bg ?? px[2 * run.row * W + col]!
        }
        col++
      }
    }

    return toBase64(new Uint8Array(words.buffer))
  }

  // ---- people ----

  private stationAt(slot: number): Point {
    const { gridCols, gridLeft } = this.L

    return { x: gridLeft + (slot % gridCols) * STATION_W, y: GRID_TOP + Math.floor(slot / gridCols) * STATION_H }
  }

  private seatOf(slot: number): Point {
    const at = this.stationAt(slot)

    return { x: at.x + (STATION_W - SPRITE_W) / 2, y: at.y + 2 }
  }

  private doorSpot(): Point {
    return { x: this.L.doorX + (DOOR_W - SPRITE_W) / 2, y: DOOR_Y + DOOR_H - SPRITE_H }
  }

  private seatedActor(id: string, slot: number): Actor {
    const seat = this.seatOf(slot)

    return { id, slot, phase: 'seated', x: seat.x, y: seat.y, t: 0, fade: 1, path: [], blinkAt: this.blinkFor(id) }
  }

  private blinkFor(id: string): number {
    let hash = 0
    for (const ch of id) hash = (hash * 31 + (ch.codePointAt(0) ?? 0)) | 0

    return 30 + (Math.abs(hash) % 40)
  }

  private freeSlot(): number | undefined {
    for (let i = 0; i < this.L.capacity; i++) {
      if (!this.slots[i]) return i
    }
    // Recycle the desk whose owner left longest ago.
    for (let i = 0; i < this.L.capacity; i++) {
      const owner = this.slots[i]
      const actor = owner ? this.actors.get(owner) : undefined
      if (actor && actor.phase === 'gone') {
        this.actors.delete(owner!)

        return i
      }
    }

    return undefined
  }

  // Only someone at work takes a desk; a dozing teammate gives its desk up to
  // a newcomer and walks out, and walks back in when it wakes.
  private seatNewcomers(): void {
    for (const id of this.order) {
      const agent = this.agents.get(id)
      if (!agent || this.actors.has(id) || agent.status !== 'working') continue
      const slot = this.freeSlot()
      if (slot === undefined) return this.sendDozerOut()
      this.slots[slot] = id
      const spot = this.doorSpot()
      this.actors.set(id, { id, slot, phase: 'queued', x: spot.x, y: spot.y, t: 0, fade: 0, path: [], blinkAt: this.blinkFor(id) })
    }
  }

  // One at a time through the doorway: someone fading there, or on the short
  // walk between it and the corridor, holds it. A newcomer also waits for the
  // last one in to step clear of the door.
  private sendDozerOut(): void {
    for (const actor of this.actors.values()) {
      if (actor.phase === 'walking-out' || actor.phase === 'leaving') return
    }
    for (const actor of this.actors.values()) {
      if (actor.phase !== 'seated' || this.agents.get(actor.id)?.status !== 'idle') continue
      this.leave(actor)

      return
    }
  }

  private leave(actor: Actor): void {
    const spot = this.doorSpot()
    actor.path = [
      { x: actor.x, y: CORRIDOR_Y },
      { x: spot.x, y: CORRIDOR_Y },
      { x: spot.x, y: spot.y },
    ]
    this.enter(actor, 'walking-out')
  }

  private isDoorwayBusy(self: Actor): boolean {
    const spot = this.doorSpot()
    for (const other of this.actors.values()) {
      if (other === self || other.phase === 'gone' || other.phase === 'queued') continue
      if (other.phase === 'arriving' || other.phase === 'leaving') return true
      if (other.y < CORRIDOR_Y) return true
      const isAtDoor = Math.abs(other.x - spot.x) < SPRITE_W && other.y === CORRIDOR_Y
      if (self.phase === 'queued' && isAtDoor && other.phase === 'walking-in') return true
    }

    return false
  }

  private advance(actor: Actor): void {
    actor.t++
    const agent = this.agents.get(actor.id)
    const hasEnded = !agent || agent.status === 'done' || agent.status === 'failed'

    switch (actor.phase) {
      case 'queued':
        if (this.door >= DOOR_OPEN - 1 && !this.isDoorwayBusy(actor)) this.enter(actor, 'arriving')
        break
      case 'arriving':
        actor.fade = Math.min(1, actor.t / FADE_STEPS)
        if (actor.t >= FADE_STEPS) {
          const seat = this.seatOf(actor.slot)
          actor.path = [
            { x: actor.x, y: CORRIDOR_Y },
            { x: seat.x, y: CORRIDOR_Y },
            { x: seat.x, y: seat.y },
          ]
          this.enter(actor, 'walking-in')
        }
        break
      case 'walking-in':
        if (this.walk(actor)) this.enter(actor, 'seated')
        break
      case 'seated':
        if (hasEnded) this.enter(actor, 'cheer')
        break
      case 'cheer':
        if (actor.t >= CHEER_TICKS) this.leave(actor)
        break
      case 'walking-out': {
        // Wait on the corridor, before the doorway, for it to be free.
        const isAtThreshold = actor.path.length === 1 && actor.y === CORRIDOR_Y
        if (isAtThreshold && (this.door < DOOR_OPEN - 1 || this.isDoorwayBusy(actor))) break
        if (this.walk(actor)) this.enter(actor, 'leaving')
        break
      }
      case 'leaving':
        actor.fade = Math.max(0, 1 - actor.t / FADE_STEPS)
        if (actor.t >= FADE_STEPS) this.enter(actor, 'gone')
        break
      case 'gone':
        // Resumed after it left: free the desk so it walks in again.
        if (!hasEnded) {
          this.actors.delete(actor.id)
          if (this.slots[actor.slot] === actor.id) this.slots[actor.slot] = null
        }
        break
    }
  }

  private enter(actor: Actor, phase: Phase): void {
    actor.phase = phase
    actor.t = 0
  }

  // Moves one step along the path; true once it ends.
  private walk(actor: Actor): boolean {
    const target = actor.path[0]
    if (!target) return true
    if (actor.x !== target.x) {
      actor.x += Math.sign(target.x - actor.x) * Math.min(2, Math.abs(target.x - actor.x))
    } else if (actor.y !== target.y) {
      actor.y += Math.sign(target.y - actor.y)
    }
    if (actor.x === target.x && actor.y === target.y) actor.path.shift()

    return actor.path.length === 0
  }

  private moveDoor(): void {
    let isWanted = false
    const spot = this.doorSpot()
    for (const actor of this.actors.values()) {
      if (actor.phase === 'queued' || actor.phase === 'arriving' || actor.phase === 'leaving') isWanted = true
      if (actor.phase === 'walking-out' && actor.path.length <= 2 && Math.abs(actor.x - spot.x) < 30) isWanted = true
      if (actor.phase === 'walking-in' && actor.y < CORRIDOR_Y) isWanted = true
    }
    if (isWanted) {
      this.doorIdle = 0
      this.door = Math.min(DOOR_OPEN, this.door + 1)
    } else if (++this.doorIdle > LINGER_TICKS) {
      this.door = Math.max(0, this.door - 1)
    }
  }

  // A resize puts everyone where the new layout has them. Only a change that
  // moves desks or the door cuts walks short; more or fewer rows of desks
  // leaves everyone walking.
  private resize(columns: number, rows: number): void {
    if (this.L.W === columns && this.L.rows === rows) return
    const before = this.L
    this.L = layoutFor(columns, rows)
    const keep = this.slots.slice(0, this.L.capacity)
    const hasMoved = before.gridCols !== this.L.gridCols || before.gridLeft !== this.L.gridLeft || before.doorX !== this.L.doorX
    if (!hasMoved) {
      for (const [id, actor] of this.actors) {
        if (actor.slot >= this.L.capacity) this.actors.delete(id)
      }
      this.slots = keep

      return
    }
    for (const [id, actor] of this.actors) {
      if (actor.slot >= this.L.capacity) {
        this.actors.delete(id)
        continue
      }
      if (actor.phase === 'walking-in' || actor.phase === 'arriving' || actor.phase === 'queued') {
        this.actors.set(id, this.seatedActor(id, actor.slot))
      } else if (actor.phase === 'walking-out' || actor.phase === 'leaving') {
        this.enter(actor, 'gone')
      } else {
        const seat = this.seatOf(actor.slot)
        actor.x = seat.x
        actor.y = seat.y
      }
    }
    this.slots = keep
  }

  // ---- painting ----

  private paint(px: Uint32Array, texts: TextRun[]): void {
    const { W, H } = this.L
    const set = (x: number, y: number, color: number) => {
      if (x >= 0 && x < W && y >= 0 && y < H) px[y * W + x] = color
    }
    const rect = (x: number, y: number, w: number, h: number, color: number) => {
      for (let j = y; j < y + h; j++) for (let i = x; i < x + w; i++) set(i, j, color)
    }

    this.paintRoom(set, rect, texts)

    // Painter's order: by the y each thing stands on.
    const items: { z: number; draw: () => void }[] = []
    for (let slot = 0; slot < this.L.capacity; slot++) {
      const owner = this.slots[slot]
      if (!owner) continue
      const at = this.stationAt(slot)
      if (at.y + STATION_H > H + 2) continue
      const actor = this.actors.get(owner)
      const isSeated = actor !== undefined && (actor.phase === 'seated' || actor.phase === 'cheer')
      if (!isSeated) items.push({ z: at.y + 5, draw: () => this.paintChair(rect, set, at) })
      items.push({ z: at.y + 7, draw: () => this.paintDesk(rect, set, texts, at, owner) })
    }
    for (const actor of this.actors.values()) {
      if (actor.phase === 'gone' || actor.phase === 'queued') continue
      items.push({ z: actor.y + SPRITE_H - 1, draw: () => this.paintActor(set, texts, actor) })
    }
    items.sort((a, b) => a.z - b.z)
    for (const item of items) item.draw()

    this.paintHeader(texts)
  }

  private paintRoom(
    set: (x: number, y: number, c: number) => void,
    rect: (x: number, y: number, w: number, h: number, c: number) => void,
    texts: TextRun[],
  ): void {
    const { W, H, doorX } = this.L

    // Header strip.
    rect(0, 0, W, WALL_TOP, C.header)

    // Wall, wainscot, baseboard.
    for (let y = WALL_TOP; y < FLOOR_TOP; y++) {
      for (let x = 0; x < W; x++) set(x, y, x % 8 === 0 ? C.wallStripe : C.wall)
    }
    rect(0, 10, W, 3, C.wainscot)
    rect(0, 10, W, 1, C.wainscotTrim)
    rect(0, 13, W, 1, C.baseboard)

    // Floor planks.
    for (let y = FLOOR_TOP; y < H; y++) {
      const row = Math.floor((y - FLOOR_TOP) / 3)
      for (let x = 0; x < W; x++) {
        const isSeam = (x + row * 7) % 16 === 0
        set(x, y, isSeam ? C.seam : row % 2 === 0 ? C.plankA : C.plankB)
      }
    }
    rect(0, FLOOR_TOP, W, 1, C.floorShadow)

    // Window with twinkling stars.
    if (W >= 44) {
      rect(3, 3, 14, 7, C.windowFrame)
      rect(4, 4, 12, 5, C.sky)
      rect(9, 4, 2, 5, C.windowFrame)
      const stars: Point[] = [{ x: 5, y: 5 }, { x: 7, y: 7 }, { x: 12, y: 4 }, { x: 14, y: 6 }, { x: 13, y: 8 }]
      stars.forEach((s, i) => set(s.x, s.y, (this.tick + i * 7) % 24 < 18 ? C.star : C.starDim))
    }

    // The Claude starburst, framed.
    if (W >= 60) {
      const fx = Math.floor((W - DOOR_W) / 2) - 4
      rect(fx, 3, 9, 9, C.frame)
      rect(fx + 1, 4, 7, 7, C.canvas)
      STARBURST.forEach((line, j) =>
        [...line].forEach((ch, i) => {
          if (ch === '#') set(fx + 1 + i, 4 + j, C.clawd)
        }),
      )
    }

    // A plant by the wall.
    if (W >= 36) {
      rect(2, 17, 5, 4, C.pot)
      rect(1, 17, 7, 1, C.clawdDark)
      const leaves: Point[] = [{ x: 4, y: 11 }, { x: 3, y: 12 }, { x: 5, y: 12 }, { x: 2, y: 13 }, { x: 4, y: 13 }, { x: 6, y: 13 }, { x: 3, y: 14 }, { x: 5, y: 14 }, { x: 1, y: 15 }, { x: 4, y: 15 }, { x: 7, y: 15 }, { x: 2, y: 16 }, { x: 4, y: 16 }, { x: 6, y: 16 }]
      leaves.forEach((p, i) => set(p.x, p.y, i % 3 === 0 ? C.leafDark : C.leaf))
    }

    // The door: dark inside, two leaves that slide apart.
    rect(doorX - 1, DOOR_Y - 1, DOOR_W + 2, DOOR_H + 1, C.doorFrame)
    rect(doorX, DOOR_Y, DOOR_W, DOOR_H, C.dark)
    const leafW = DOOR_LEAF - this.door
    if (leafW > 0) {
      rect(doorX, DOOR_Y, leafW, DOOR_H, C.doorLeaf)
      rect(doorX + DOOR_W - leafW, DOOR_Y, leafW, DOOR_H, C.doorLeaf)
      if (leafW >= 4) {
        rect(doorX + 1, DOOR_Y + 1, leafW - 2, 2, C.doorGlass)
        rect(doorX + DOOR_W - leafW + 1, DOOR_Y + 1, leafW - 2, 2, C.doorGlass)
        rect(doorX + 1, DOOR_Y + 5, leafW - 2, 3, C.doorPanel)
        rect(doorX + DOOR_W - leafW + 1, DOOR_Y + 5, leafW - 2, 3, C.doorPanel)
      }
      set(doorX + leafW - 2, DOOR_Y + 5, C.knob)
      set(doorX + DOOR_W - leafW + 1, DOOR_Y + 5, C.knob)
    }

    // The exit sign above it.
    const sign = 'SALIDA'
    const signCol = doorX + Math.floor((DOOR_W - sign.length) / 2)
    texts.push({ col: signCol, row: 1, text: sign, fg: C.exitText, bg: C.exitBg })
  }

  private paintChair(
    rect: (x: number, y: number, w: number, h: number, c: number) => void,
    set: (x: number, y: number, c: number) => void,
    at: Point,
  ): void {
    rect(at.x + 8, at.y + 2, 8, 4, C.chair)
    rect(at.x + 9, at.y + 2, 6, 1, C.chairHi)
    set(at.x + 8, at.y + 2, C.plankA)
    set(at.x + 15, at.y + 2, C.plankA)
  }

  private paintDesk(
    rect: (x: number, y: number, w: number, h: number, c: number) => void,
    set: (x: number, y: number, c: number) => void,
    texts: TextRun[],
    at: Point,
    owner: string,
  ): void {
    const agent = this.agents.get(owner)
    const isWorking = agent?.status === 'working'

    // Shadow and legs.
    rect(at.x + 3, at.y + 10, 18, 1, C.floorShadow)
    rect(at.x + 2, at.y + 10, 2, 2, C.deskLeg)
    rect(at.x + 20, at.y + 10, 2, 2, C.deskLeg)

    // Laptop, its back to us, the logo glowing while someone works.
    rect(at.x + 9, at.y + 4, 6, 2, C.laptop)
    const glow = isWorking && this.tick % 10 < 5 ? C.clawdLight : C.clawd
    set(at.x + 11, at.y + 4, isWorking ? glow : C.laptopDark)
    set(at.x + 12, at.y + 4, isWorking ? glow : C.laptopDark)

    // Top, edge, front.
    rect(at.x + 1, at.y + 6, 22, 1, C.deskTop)
    rect(at.x + 8, at.y + 6, 8, 1, C.laptopDark)
    rect(at.x + 1, at.y + 7, 22, 1, C.deskEdge)
    rect(at.x + 1, at.y + 8, 22, 2, C.deskFront)

    // The nameplate: the task's name on the desk's front.
    if (!agent) return
    const icon =
      agent.status === 'done' ? '✓' : agent.status === 'failed' ? '✗' : agent.status === 'idle' ? 'z' : '●'
    const iconColor =
      agent.status === 'done'
        ? C.ok
        : agent.status === 'failed'
          ? C.fail
          : agent.status === 'idle'
            ? C.zzz
            : this.tick % 12 < 6
              ? C.clawdLight
              : C.clawd
    const name = clip(cellSafe(agent.label), 19)
    const pad = Math.max(0, Math.floor((20 - [...name].length - 2) / 2))
    const row = (at.y + 8) / 2
    texts.push({ col: at.x + 2 + pad, row, text: icon, fg: iconColor, bg: C.deskFront })
    texts.push({
      col: at.x + 4 + pad,
      row,
      text: name,
      fg: agent.status === 'done' ? C.ok : agent.status === 'failed' ? C.fail : C.nameText,
      bg: C.deskFront,
    })
  }

  private paintActor(set: (x: number, y: number, c: number) => void, texts: TextRun[], actor: Actor): void {
    const agent = this.agents.get(actor.id)
    const isMoving = actor.phase === 'walking-in' || actor.phase === 'walking-out'
    let frame: Frame = 'stand'
    let eyes: Eyes = 'open'
    let dy = 0

    if (isMoving) frame = Math.floor(actor.t / 2) % 2 === 0 ? 'stand' : 'walk'
    if (actor.phase === 'seated') {
      if (agent?.status === 'idle') eyes = 'closed'
      else frame = Math.floor(this.tick / 2) % 2 === 0 ? 'typeLeft' : 'typeRight'
    }
    if (actor.phase === 'cheer') {
      if (agent?.status === 'failed') eyes = 'closed'
      else {
        frame = 'cheer'
        dy = actor.t % 6 < 3 ? -2 : 0
      }
    }
    if (eyes === 'open' && (this.tick + actor.blinkAt) % actor.blinkAt === 0) eyes = 'closed'

    const lit = (color: number) => (actor.fade >= 1 ? color : mix(C.dark, color, actor.fade))
    // In the doorway the sprite is clipped to the door.
    const isInDoorway = actor.phase === 'arriving' || actor.phase === 'leaving'
    const { doorX } = this.L

    CLAWD[frame].forEach((line, j) => {
      [...line].forEach((ch, i) => {
        if (ch === '.') return
        const x = actor.x + i
        const y = actor.y + j + dy
        if (isInDoorway && (x < doorX || x >= doorX + DOOR_W)) return
        const color = ch === 'e' ? (eyes === 'open' ? C.eye : C.eyeClosed) : ch === 'l' ? C.clawdDark : C.clawd
        set(x, y, lit(color))
      })
    })

    // What it is up to, just above its head while seated.
    if (actor.phase !== 'seated' && actor.phase !== 'cheer') return
    const at = this.stationAt(actor.slot)
    // The cheer jumps into the row above the head, so its words go a row higher.
    let row = at.y / 2
    let text = ''
    let fg = C.activity
    if (actor.phase === 'cheer') {
      if (agent?.status !== 'failed') row--
      text = agent?.status === 'failed' ? '✗ falló' : this.tick % 6 < 3 ? '*  listo  *' : ' * listo * '
      fg = agent?.status === 'failed' ? C.fail : C.spark
    } else if (agent?.status === 'idle') {
      text = ['z', 'z z', 'z z z'][Math.floor(this.tick / 6) % 3]!
      fg = C.zzz
    } else {
      text = cellSafe(agent?.activity ?? 'pensando' + '.'.repeat(Math.floor(this.tick / 5) % 4))
    }
    text = clip(text, STATION_W - 2)
    const col = at.x + Math.max(1, Math.floor((STATION_W - [...text].length) / 2))
    texts.push({ col, row, text, fg })
  }

  private paintHeader(texts: TextRun[]): void {
    const { W } = this.L
    const n = this.counts()
    const parts = [`● ${n.working} trabajando`]
    if (n.idle > 0) parts.push(`z ${n.idle} en pausa`)
    parts.push(`✓ ${n.done} listas`)
    if (n.failed > 0) parts.push(`✗ ${n.failed} fallidas`)
    if (n.queued > 0) parts.push(`+${n.queued} en espera`)
    texts.push({ col: 1, row: 0, text: clip('OFICINA', W - 1), fg: C.clawd, bg: C.header })
    texts.push({ col: 10, row: 0, text: clip(parts.join(' · '), W - 11), fg: C.headerDim, bg: C.header })
  }
}
