import type { Diagram, DiagramEdge, DiagramNode, Status } from '../types'

export const STATUSES: readonly Status[] = ['planned', 'building', 'done', 'blocked']
const MAX_NODES = 100
const MAX_EDGES = 200

export type Patch = {
  title?: string
  nodes?: DiagramNode[]
  removeNodes?: string[]
  edges?: DiagramEdge[]
  removeEdges?: { from: string; to: string }[]
}

export const empty = (): Diagram => ({ nodes: [], edges: [] })

const edgeKey = (e: { from: string; to: string }) => `${e.from}\u0000${e.to}`

/** Upserts nodes (merged by id) and edges (by from→to); removing a node drops its edges. */
export function applyPatch(d: Diagram, p: Patch): Diagram {
  const nodes = new Map(d.nodes.map(n => [n.id, n]))
  for (const n of p.nodes ?? []) {
    // A field patched to "" is cleared.
    const merged: Record<string, unknown> = { ...nodes.get(n.id), ...n }
    for (const k of Object.keys(merged)) if (k !== 'id' && merged[k] === '') delete merged[k]
    nodes.set(n.id, merged as DiagramNode)
  }
  const gone = new Set(p.removeNodes ?? [])
  for (const id of gone) nodes.delete(id)

  const edges = new Map(d.edges.map(e => [edgeKey(e), e]))
  for (const e of p.edges ?? []) edges.set(edgeKey(e), e)
  for (const e of p.removeEdges ?? []) edges.delete(edgeKey(e))

  return {
    title: p.title ?? d.title,
    nodes: [...nodes.values()],
    edges: [...edges.values()].filter(e => !gone.has(e.from) && !gone.has(e.to)),
  }
}

/**
 * JSON text the model is still writing, cut after the last object or array it finished and
 * closed off: the values written so far, whole. Undefined until one has ended.
 */
export function partialJson(text: string): unknown {
  let stack = ''
  let open = ''
  let cut = -1
  let inString = false
  let escaped = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (inString) {
      if (escaped) escaped = false
      else if (c === '\\') escaped = true
      else if (c === '"') inString = false
    } else if (c === '"') inString = true
    else if (c === '{' || c === '[') stack += c
    else if (c === '}' || c === ']') {
      stack = stack.slice(0, -1)
      cut = i + 1
      open = stack
    }
  }
  if (cut < 0) return undefined
  const close = [...open].reverse().map(c => (c === '{' ? '}' : ']')).join('')
  try {
    return JSON.parse(text.slice(0, cut) + close)
  } catch {
    return undefined
  }
}

const isStr = (v: unknown): v is string => typeof v === 'string'
const optStr = (v: unknown) => v === undefined || isStr(v)

/** The model's input is untrusted: returns what is wrong with it, or undefined. */
export function check(d: Diagram): string | undefined {
  if (!Array.isArray(d.nodes) || !Array.isArray(d.edges)) return 'nodes and edges must be arrays'
  if (d.nodes.length > MAX_NODES) return `at most ${MAX_NODES} nodes`
  if (d.edges.length > MAX_EDGES) return `at most ${MAX_EDGES} edges`
  const ids = new Set<string>()
  for (const n of d.nodes) {
    if (!isStr(n?.id) || n.id === '') return 'every node needs a non-empty string id'
    if (ids.has(n.id)) return `duplicate node id "${n.id}"`
    ids.add(n.id)
    if (![n.label, n.kind, n.group, n.note, n.detail].every(optStr)) return `node "${n.id}": label/kind/group/note/detail must be strings`
    if (n.status !== undefined && !STATUSES.includes(n.status)) {
      return `node "${n.id}": status must be one of ${STATUSES.join(', ')}`
    }
  }
  for (const e of d.edges) {
    if (!isStr(e?.from) || !isStr(e?.to) || !optStr(e.label)) return 'every edge needs string from/to'
    if (!ids.has(e.from)) return `edge ${e.from}→${e.to}: unknown node "${e.from}"`
    if (!ids.has(e.to)) return `edge ${e.from}→${e.to}: unknown node "${e.to}"`
  }

  return undefined
}

// ---- layout ---------------------------------------------------------------

export const BOX_H = 4
const H_GAP = 3
const D_GAP = 2
const MIN_W = 10
const MAX_W = 26
const SWEEPS = 24
// Rounds of re-placing ranks after a group moves, and of pulling x toward neighbors:
// both settle in a few on the diagram sizes the caps allow.
const SETTLE_ROUNDS = 8
const X_PASSES = 4
// A group's border column, then a blank one, on each side of its members.
const G_PAD = 2
// Joins a group's name to the index of one of its runs of ranks.
const RUN = '\u0001'

type Placed = { node: DiagramNode; x: number; y: number; w: number; label: string; sub: string }
type GroupRect = { name: string; x: number; y: number; w: number; h: number }
export type Layout = { width: number; height: number; boxes: Placed[]; groups: GroupRect[]; rows: string[] }

// Terminal cells: a wide character (CJK, most emoji) takes two, the second held by ''.
// ponytail: a range table, not full Unicode width; ZWJ sequences and flags can still misalign.
const WIDE: [number, number][] = [
  [0x1100, 0x115f], [0x2e80, 0x303e], [0x3041, 0x33ff], [0x3400, 0x4dbf], [0x4e00, 0x9fff],
  [0xa000, 0xa4cf], [0xac00, 0xd7a3], [0xf900, 0xfaff], [0xfe30, 0xfe4f], [0xff00, 0xff60],
  [0xffe0, 0xffe6], [0x1f300, 0x1f64f], [0x1f680, 0x1f6ff], [0x1f900, 0x1f9ff], [0x1fa70, 0x1faff],
  [0x20000, 0x3fffd],
]
const isWide = (cp: number) => WIDE.some(([a, b]) => cp >= a && cp <= b)
const isZero = (cp: number) => cp === 0x200d || (cp >= 0xfe00 && cp <= 0xfe0f) || (cp >= 0x300 && cp <= 0x36f)

/** The cells `s` takes on a terminal, one string per cell; joiners and marks ride the cell before. */
export function cells(s: string): string[] {
  const out: string[] = []
  for (const ch of s) {
    const cp = ch.codePointAt(0)!
    if (isZero(cp) && out.length > 0) {
      const at = out[out.length - 1] === '' ? out.length - 2 : out.length - 1
      out[at] = out[at]! + ch
    } else if (isWide(cp)) {
      out.push(ch, '')
    } else {
      out.push(ch)
    }
  }
  return out
}
export const textWidth = (s: string) => cells(s).length

/** `s` cut to `n` cells with an ellipsis, never through a character. */
export function clip(s: string, n: number): string {
  const c = cells(s)
  if (c.length <= n) return s
  const kept = c.slice(0, n - 1)
  if (kept[kept.length - 1] !== '' && c[kept.length] === '') kept.pop()
  return `${kept.join('')}…`
}
const avg = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length

/** An edge pointed down the ranks: `rev` when it closed a cycle and was turned around. */
type Oriented = { u: string; v: string; edge: DiagramEdge; rev: boolean }

/** A DFS turns every edge closing a cycle around, so the graph ranks as a DAG. */
function orient(d: Diagram): Oriented[] {
  const out = new Map<string, DiagramEdge[]>(d.nodes.map(n => [n.id, []]))
  for (const e of d.edges) if (e.from !== e.to) out.get(e.from)!.push(e)
  const state = new Map<string, 1 | 2>()
  const res: Oriented[] = []
  const visit = (id: string) => {
    state.set(id, 1)
    for (const e of out.get(id)!) {
      if (state.get(e.to) === 1) {
        res.push({ u: e.to, v: e.from, edge: e, rev: true })
        continue
      }
      res.push({ u: id, v: e.to, edge: e, rev: false })
      if (!state.has(e.to)) visit(e.to)
    }
    state.set(id, 2)
  }
  for (const n of d.nodes) if (!state.has(n.id)) visit(n.id)

  return res
}

/** Longest path: each node one rank below its deepest parent. */
function rank(d: Diagram, edges: Oriented[]): Map<string, number> {
  const r = new Map(d.nodes.map(n => [n.id, 0]))
  const indeg = new Map(d.nodes.map(n => [n.id, 0]))
  for (const e of edges) indeg.set(e.v, indeg.get(e.v)! + 1)
  const queue = d.nodes.filter(n => indeg.get(n.id) === 0).map(n => n.id)
  while (queue.length > 0) {
    const id = queue.shift()!
    for (const e of edges) {
      if (e.u !== id) continue
      r.set(e.v, Math.max(r.get(e.v)!, r.get(id)! + 1))
      indeg.set(e.v, indeg.get(e.v)! - 1)
      if (indeg.get(e.v) === 0) queue.push(e.v)
    }
  }

  return r
}

/** A box, or a waypoint (no node) a long edge passes through on its way down. */
type Item = { node?: DiagramNode; group?: string; rank: number; w: number; label: string; sub: string }
/** One hop of an edge between adjacent ranks, item `a` above `b`. */
type Hop = { a: number; b: number; edge: DiagramEdge; rev: boolean; first: boolean; last: boolean }

/**
 * The ranked graph every layout phase reads: boxes then waypoints, the hops between
 * them, and both indexed once. Item and hop numbers are indexes into `items` and `hops`.
 */
type Graph = {
  items: Item[]
  hops: Hop[]
  depth: number
  /** Per item: the items one rank up / down that a hop links it to. */
  ups: number[][]
  downs: number[][]
  /** Per item: the hops leaving it downward / arriving from above. */
  outs: number[][]
  ins: number[][]
  /** Per rank: the hops in the gap below it. */
  below: number[][]
}

function build(d: Diagram): Graph {
  const edges = orient(d)
  const ranks = rank(d, edges)
  const depth = Math.max(...ranks.values()) + 1

  const items: Item[] = d.nodes.map(n => {
    const sub = [n.kind, n.status].filter(Boolean).join(' · ')
    // A box that opens into a diagram of its own says so after its label.
    const mark = n.detail ? ' ▸' : ''
    const base = n.label ?? n.id
    const w = Math.min(MAX_W, Math.max(MIN_W, textWidth(base) + textWidth(mark) + 4, textWidth(sub) + 4))
    const label = clip(base, w - 4 - textWidth(mark)) + mark
    return { node: n, group: n.group || undefined, rank: ranks.get(n.id)!, w, label, sub: clip(sub, w - 4) }
  })
  const itemOf = new Map(d.nodes.map((n, i) => [n.id, i]))
  const hops: Hop[] = []
  for (const e of edges) {
    const start = itemOf.get(e.u)!, end = itemOf.get(e.v)!
    // A waypoint is inside a group only when both ends are.
    const group = items[start]!.group === items[end]!.group ? items[end]!.group : undefined
    let prev = start
    for (let r = items[start]!.rank + 1; r <= items[end]!.rank; r++) {
      const next = r === items[end]!.rank ? end : items.push({ group, rank: r, w: 1, label: '', sub: '' }) - 1
      hops.push({ a: prev, b: next, edge: e.edge, rev: e.rev, first: prev === start, last: next === end })
      prev = next
    }
  }

  const perItem = () => items.map(() => [] as number[])
  const ups = perItem(), downs = perItem(), outs = perItem(), ins = perItem()
  const below = Array.from({ length: depth }, () => [] as number[])
  hops.forEach((h, k) => {
    ups[h.b]!.push(h.a)
    downs[h.a]!.push(h.b)
    outs[h.a]!.push(k)
    ins[h.b]!.push(k)
    below[items[h.a]!.rank]!.push(k)
  })

  return { items, hops, depth, ups, downs, outs, ins, below }
}

/**
 * Crossings between adjacent ranks: the inversions of each gap's hops' (top, bottom)
 * positions. Sorted by top, count the earlier hops ending further right with a
 * Fenwick tree over bottom positions: O(E log E) per gap.
 */
function crossings(g: Graph, posOf: number[]): number {
  let total = 0
  for (const ks of g.below) {
    const pairs = ks.map(k => [posOf[g.hops[k]!.a]!, posOf[g.hops[k]!.b]!] as const).sort((p, q) => p[0] - q[0] || p[1] - q[1])
    const size = pairs.reduce((m, p) => Math.max(m, p[1]), 0) + 2
    const tree = new Array<number>(size + 1).fill(0)
    const add = (pos: number) => {
      for (let i = pos + 1; i <= size; i += i & -i) tree[i]!++
    }
    const countUpTo = (pos: number) => {
      let n = 0
      for (let i = pos + 1; i > 0; i -= i & -i) n += tree[i]!
      return n
    }
    let seen = 0
    for (let i = 0; i < pairs.length; ) {
      let j = i
      while (j < pairs.length && pairs[j]![0] === pairs[i]![0]) j++
      // Hops from the same top never cross each other: count the whole run, then add it.
      for (let k = i; k < j; k++) total += seen - countUpTo(pairs[k]![1])
      for (let k = i; k < j; k++) add(pairs[k]![1])
      seen += j - i
      i = j
    }
  }

  return total
}

/** Orders each rank: alternate down and up barycenter sweeps, keep the order with the fewest crossings. */
function orderRanks(g: Graph): { layers: number[][]; posOf: number[] } {
  let layers: number[][] = Array.from({ length: g.depth }, () => [])
  g.items.forEach((item, it) => layers[item.rank]!.push(it))
  const posOf: number[] = new Array(g.items.length).fill(0)
  const index = () => layers.forEach(l => l.forEach((it, i) => (posOf[it] = i)))
  index()
  let best = crossings(g, posOf)
  let bestLayers = layers.map(l => [...l])
  for (let sweep = 0; sweep < SWEEPS && best > 0; sweep++) {
    const down = sweep % 2 === 0
    const nb = down ? g.ups : g.downs
    for (let k = 1; k < g.depth; k++) {
      const r = down ? k : g.depth - 1 - k
      const bary = new Map(layers[r]!.map(it => [it, nb[it]!.length > 0 ? avg(nb[it]!.map(n => posOf[n]!)) : posOf[it]!]))
      layers[r] = [...layers[r]!].sort((p, q) => bary.get(p)! - bary.get(q)!)
      layers[r]!.forEach((it, i) => (posOf[it] = i))
    }
    const c = crossings(g, posOf)
    if (c < best) {
      best = c
      bestLayers = layers.map(l => [...l])
    }
  }
  layers = bestLayers
  index()

  return { layers, posOf }
}

/** One slot of a rank, left to right: a lone item, or a group's block of members. */
type Entry = { item: number } | { group: string; members: number[] }
/** Groups as blocks: each run's first and last rank, and every rank's slots in order. */
type Blocks = { runs: string[]; span: Map<string, [number, number]>; entries: Entry[][] }

const groupName = (run: string) => run.split(RUN)[0]!

/**
 * Groups: members sit in one block per rank, blocks in one global left-to-right order
 * (by where the sweeps put their members), and each group owns one column range on
 * every rank it spans, so its border holds its members and nothing else.
 * A group whose members skip ranks is drawn as one border per run of consecutive ranks:
 * one rectangle over the gap would wall off every rank in between. So each item's
 * `group` becomes its run (`name RUN index`); a waypoint outside every run is outside.
 */
function blockGroups(g: Graph, layers: number[][], posOf: number[]): Blocks {
  const { items } = g
  const ranksOf = new Map<string, number[]>()
  for (const item of items) if (item.group && item.node) ranksOf.set(item.group, [...(ranksOf.get(item.group) ?? []), item.rank])
  for (const [name, rs] of ranksOf) {
    const sorted = [...new Set(rs)].sort((a, b) => a - b)
    const runAt = new Map<number, number>()
    sorted.forEach((r, i) => runAt.set(r, i > 0 && r === sorted[i - 1]! + 1 ? runAt.get(sorted[i - 1]!)! : i))
    for (const item of items) {
      if (item.group !== name) continue
      item.group = runAt.has(item.rank) ? `${name}${RUN}${runAt.get(item.rank)}` : undefined
    }
  }

  const runs = [...new Set(items.flatMap(item => (item.group ? [item.group] : [])))]
  const span = new Map(runs.map(run => [run, [Infinity, -Infinity] as [number, number]]))
  for (const item of items) {
    if (!item.group) continue
    const sp = span.get(item.group)!
    sp[0] = Math.min(sp[0], item.rank)
    sp[1] = Math.max(sp[1], item.rank)
  }
  // Where an item sits across its rank, 0..1, so ranks of different sizes compare.
  const across = (it: number) => (posOf[it]! + 0.5) / layers[items[it]!.rank]!.length
  const runOrder = new Map(runs.map(run => [run, avg(items.flatMap((item, it) => (item.group === run ? [across(it)] : [])))]))
  const entries: Entry[][] = layers.map((l, r) => {
    const keyed: [number, number, Entry][] = l.filter(it => !items[it]!.group).map(it => [across(it), 0, { item: it }])
    for (const run of runs) {
      const [a, b] = span.get(run)!
      if (r >= a && r <= b) keyed.push([runOrder.get(run)!, 1, { group: run, members: l.filter(it => items[it]!.group === run) }])
    }
    return keyed.sort((p, q) => p[0] - q[0] || p[1] - q[1]).map(k => k[2])
  })

  return { runs, span, entries }
}

const centerOf = (item: Item, x: number) => x + Math.floor(item.w / 2)

/**
 * x: pack each rank, then pull every item toward its neighbors' centers, keeping order,
 * spacing and every group's column range. Item and group x end up starting at 0.
 */
function placeX(g: Graph, { runs, entries }: Blocks) {
  const { items, depth, ups, downs } = g
  const xs: number[] = new Array(items.length).fill(0)
  const gap = (p: number, q: number) => (items[p]!.node && items[q]!.node ? H_GAP : D_GAP)
  const cx = (it: number) => centerOf(items[it]!, xs[it]!)
  const packedWidth = (ms: number[]) => ms.reduce((a, it, i) => a + items[it]!.w + (i > 0 ? gap(ms[i - 1]!, it) : 0), 0)
  const gw = new Map(runs.map(run => {
    const widest = Math.max(0, ...entries.flatMap(es => es.flatMap(e => ('group' in e && e.group === run ? [packedWidth(e.members)] : []))))
    return [run, Math.max(textWidth(groupName(run)) + 6, widest + 2 * G_PAD)]
  }))
  const gx = new Map(runs.map(run => [run, 0]))
  const after = (e: Entry, next: Entry | undefined) =>
    next === undefined ? 0 : 'item' in e && 'item' in next ? gap(e.item, next.item) : H_GAP
  // Lays items out left to right from `start`, each where it wants or right after the
  // one before; returns where the last one ends.
  const pack = (ms: number[], start: number, want: (it: number) => number) =>
    ms.reduce((x, it, j) => {
      xs[it] = Math.max(Math.round(want(it)), x)
      return xs[it]! + items[it]!.w + (j + 1 < ms.length ? gap(it, ms[j + 1]!) : 0)
    }, start)
  const placeRank = (es: Entry[], want: (it: number) => number) => {
    let min = -Infinity
    es.forEach((e, i) => {
      if ('item' in e) {
        xs[e.item] = Math.max(Math.round(want(e.item)), min)
        min = xs[e.item]! + items[e.item]!.w + after(e, es[i + 1])
        return
      }
      // A group only moves right here; its range is the same on every rank.
      gx.set(e.group, Math.max(gx.get(e.group)!, min))
      const left = gx.get(e.group)!, right = left + gw.get(e.group)! - G_PAD
      // Members that don't fit where they want are packed tight from the left border.
      if (pack(e.members, left + G_PAD, want) > right) pack(e.members, left + G_PAD, () => -Infinity)
      min = left + gw.get(e.group)! + after(e, es[i + 1])
    })
  }
  // A group pushed right on one rank must be placed again on the ranks done before.
  const settle = () => {
    for (let i = 0; i < SETTLE_ROUNDS; i++) {
      const before = runs.map(run => gx.get(run))
      for (const es of entries) placeRank(es, it => xs[it]!)
      if (runs.every((run, j) => gx.get(run) === before[j])) return
    }
  }

  for (const es of entries) placeRank(es, () => 0)
  settle()
  for (let pass = 0; pass < X_PASSES; pass++) {
    const down = pass % 2 === 0
    const nb = down ? ups : downs
    const want = (it: number) => (nb[it]!.length > 0 ? avg(nb[it]!.map(cx)) - Math.floor(items[it]!.w / 2) : xs[it]!)
    // Each group starts the pass where its members, on average, want it.
    for (const run of runs) {
      const ms = items.flatMap((item, it) => (item.group === run ? [it] : []))
      gx.set(run, Math.round(avg(ms.map(m => want(m) - xs[m]!))) + gx.get(run)!)
    }
    for (let k = 1; k < depth; k++) placeRank(entries[down ? k : depth - 1 - k]!, want)
    placeRank(entries[down ? 0 : depth - 1]!, it => xs[it]!)
    settle()
  }

  let minX = Infinity
  for (const x of xs) minX = Math.min(minX, x)
  for (const run of runs) minX = Math.min(minX, gx.get(run)!)
  for (let i = 0; i < xs.length; i++) xs[i] = xs[i]! - minX
  for (const run of runs) gx.set(run, gx.get(run)! - minX)
  let width = 0
  items.forEach((item, it) => (width = Math.max(width, xs[it]! + item.w)))
  for (const run of runs) width = Math.max(width, gx.get(run)! + gw.get(run)!)

  return { xs, gx, gw, width }
}

/** Per hop: the column it leaves its upper item from and the one it enters its lower item at. */
type Ports = { outPort: number[]; inPort: number[] }

/** A box spreads its hops across its width, ordered by where the other end is. */
function routePorts(g: Graph, xs: number[]): Ports {
  const { items, hops, ups, downs, outs, ins } = g
  const cx = (it: number) => centerOf(items[it]!, xs[it]!)
  const outPort: number[] = new Array(hops.length).fill(0)
  const inPort: number[] = new Array(hops.length).fill(0)
  const spread = (it: number, ks: number[], other: (k: number) => number, port: number[]) => {
    const { w, node } = items[it]!
    ;[...ks].sort((p, q) => other(p) - other(q)).forEach((k, i, all) => {
      port[k] = node ? Math.max(xs[it]! + 2, Math.min(xs[it]! + w - 3, xs[it]! + Math.round(((i + 1) * w) / (all.length + 1)))) : xs[it]!
    })
  }
  items.forEach((_, it) => {
    spread(it, outs[it]!, k => cx(hops[k]!.b), outPort)
    spread(it, ins[it]!, k => cx(hops[k]!.a), inPort)
  })
  // A box's only hop goes straight when the other end's port lands on that box anyway.
  const onBox = (it: number, x: number) => items[it]!.node !== undefined && x >= xs[it]! + 2 && x <= xs[it]! + items[it]!.w - 3
  hops.forEach((h, k) => {
    if (ups[h.b]!.length === 1 && onBox(h.b, outPort[k]!)) inPort[k] = outPort[k]!
    else if (downs[h.a]!.length === 1 && onBox(h.a, inPort[k]!)) outPort[k] = inPort[k]!
  })

  return { outPort, inPort }
}

/**
 * Lanes: each bent hop gets a horizontal track in its gap (-1: it runs straight). Where
 * one hop drops into the column another starts from, the starting one must turn first
 * (a lane above), or the two would share a vertical. Within that order, tracks pack
 * where runs don't touch. Also returns each gap's height in rows, before group borders.
 */
function assignLanes(g: Graph, { outPort, inPort }: Ports): { lane: number[]; gapH: number[] } {
  const lane: number[] = new Array(g.hops.length).fill(-1)
  const gapH: number[] = new Array(g.depth - 1).fill(2)
  g.below.forEach((ks, gi) => {
    if (gi >= g.depth - 1) return
    const bent = ks.filter(k => outPort[k] !== inPort[k])
    const lo = (k: number) => Math.min(outPort[k]!, inPort[k]!)
    const hi = (k: number) => Math.max(outPort[k]!, inPort[k]!)
    const turnsFirst = new Map(bent.map(k => [k, bent.filter(o => o !== k && inPort[k] === outPort[o])]))
    const tracks: number[][] = []
    const pending = new Set(bent)
    while (pending.size > 0) {
      const ready = [...pending].filter(k => turnsFirst.get(k)!.every(o => !pending.has(o)))
      // A cycle of such drops can't all be untangled: take the leftmost and accept the overlap.
      const k = (ready.length > 0 ? ready : [...pending]).sort((p, q) => lo(p) - lo(q))[0]!
      pending.delete(k)
      let at = Math.max(0, ...turnsFirst.get(k)!.filter(o => lane[o] !== -1).map(o => lane[o]! + 1))
      while (tracks[at]?.some(o => !(hi(o) + 1 < lo(k) || hi(k) + 1 < lo(o)))) at++
      ;(tracks[at] ??= []).push(k)
      lane[k] = at
    }
    gapH[gi] = Math.max(2, tracks.length + 2)
  })

  return { lane, gapH }
}

/**
 * y: a gap where a group ends gets its bottom border under the stub row; one where a
 * group starts gets its top border over the arrow row. The outer ranks get margins for them.
 */
function placeY(g: Graph, { runs, span }: Blocks, gapH: number[]) {
  const { depth } = g
  const endsAt = (r: number) => runs.some(run => span.get(run)![1] === r)
  const startsAt = (r: number) => runs.some(run => span.get(run)![0] === r)
  const rankY: number[] = [startsAt(0) ? 2 : 0]
  for (let r = 1; r < depth; r++) {
    const gap = gapH[r - 1]! + (endsAt(r - 1) ? 1 : 0) + (startsAt(r) ? 1 : 0)
    rankY.push(rankY[r - 1]! + BOX_H + gap)
  }
  const height = rankY[depth - 1]! + BOX_H + (endsAt(depth - 1) ? 2 : 0)
  const groupEnds = rankY.map((_, r) => endsAt(r))

  return { rankY, height, groupEnds }
}

/** Where a hop runs: down from (px, top), along its lane when it bends, down to (qx, bottom). */
type Route = { px: number; qx: number; top: number; bottom: number; laneY: number | undefined }

/**
 * The cells everything but the boxes is drawn into: a bit mask of edge lines, one of
 * group borders (so an edge crossing a border shows as a crossing), and text over both.
 */
type Grid = { width: number; height: number; lines: Uint8Array; borders: Uint8Array; text: Map<number, string> }

const U = 1, D = 2, L = 4, R = 8
const GLYPH: Record<number, string> = {
  [U]: '│', [D]: '│', [U | D]: '│', [L]: '─', [R]: '─', [L | R]: '─',
  [D | R]: '╭', [D | L]: '╮', [U | R]: '╰', [U | L]: '╯',
  [U | D | R]: '├', [U | D | L]: '┤', [D | L | R]: '┬', [U | L | R]: '┴', [U | D | L | R]: '┼',
}

const cellAt = (grid: Grid, x: number, y: number) => y * grid.width + x
const mark = (grid: Grid, mask: Uint8Array, x: number, y: number, dirs: number) => {
  if (x >= 0 && x < grid.width && y >= 0 && y < grid.height) mask[cellAt(grid, x, y)]! |= dirs
}
/** A straight line from (x0, y0) to (x1, y1), its ends open toward the outside. */
const stroke = (grid: Grid, mask: Uint8Array, x0: number, y0: number, x1: number, y1: number) => {
  if (x0 === x1) {
    const [a, b] = y0 < y1 ? [y0, y1] : [y1, y0]
    for (let y = a; y <= b; y++) mark(grid, mask, x0, y, (y > a ? U : 0) | (y < b ? D : 0))
  } else {
    const [a, b] = x0 < x1 ? [x0, x1] : [x1, x0]
    for (let x = a; x <= b; x++) mark(grid, mask, x, y0, (x > a ? L : 0) | (x < b ? R : 0))
  }
}
const write = (grid: Grid, x: number, y: number, text: string) => cells(text).forEach((c, i) => grid.text.set(cellAt(grid, x + i, y), c))
const isFree = (grid: Grid, x: number, y: number, n: number) =>
  x + n <= grid.width &&
  Array.from({ length: n }, (_, i) => cellAt(grid, x + i, y)).every(c => grid.lines[c] === 0 && grid.borders[c] === 0 && !grid.text.has(c))

/** Every hop's line and arrowhead, and the line running through each waypoint's rank. */
function drawHops(grid: Grid, g: Graph, routes: Route[], xs: number[], rankY: number[]) {
  g.items.forEach((item, it) => {
    if (!item.node) for (let y = rankY[item.rank]!; y < rankY[item.rank]! + BOX_H; y++) mark(grid, grid.lines, xs[it]!, y, U | D)
  })
  g.hops.forEach((h, k) => {
    const { px, qx, top, bottom, laneY } = routes[k]!
    const pts: [number, number][] = [[px, top]]
    if (laneY !== undefined) pts.push([px, laneY], [qx, laneY])
    pts.push([qx, bottom])
    mark(grid, grid.lines, px, top, U)
    for (let i = 1; i < pts.length; i++) stroke(grid, grid.lines, ...pts[i - 1]!, ...pts[i]!)
    if (!g.items[h.b]!.node) mark(grid, grid.lines, qx, bottom, D)
    if (h.last && !h.rev) grid.text.set(cellAt(grid, qx, bottom), '▼')
    if (h.first && h.rev) grid.text.set(cellAt(grid, px, top), '▲')
  })
}

/**
 * Each group's border, and its name where no edge crosses its top border, else its
 * bottom one, else over the top border's first crossings: a group must say what it is.
 */
function drawGroups(grid: Grid, groups: GroupRect[]) {
  for (const rect of groups) {
    const x1 = rect.x + rect.w - 1, y1 = rect.y + rect.h - 1
    stroke(grid, grid.borders, rect.x, rect.y, x1, rect.y)
    stroke(grid, grid.borders, rect.x, y1, x1, y1)
    stroke(grid, grid.borders, rect.x, rect.y, rect.x, y1)
    stroke(grid, grid.borders, x1, rect.y, x1, y1)
  }
  for (const rect of groups) {
    const text = cells(` ${clip(rect.name, rect.w - 6)} `)
    const fitsAt = (y: number) =>
      Array.from({ length: rect.w - 3 - text.length }, (_, i) => rect.x + 2 + i).find(x =>
        text.every((_, i) => grid.lines[cellAt(grid, x + i, y)] === 0 && !grid.text.has(cellAt(grid, x + i, y))),
      )
    const top = fitsAt(rect.y), bottom = top === undefined ? fitsAt(rect.y + rect.h - 1) : undefined
    const [x, y] = top !== undefined ? [top, rect.y] : bottom !== undefined ? [bottom, rect.y + rect.h - 1] : [rect.x + 2, rect.y]
    text.forEach((c, i) => grid.text.set(cellAt(grid, x + i, y), c))
  }
}

/**
 * Edge labels go on after every line: centered on a bent hop's lane where it fits,
 * else beside a vertical, only into free cells. The rest show in the hover detail.
 * Only the hop leaving the source is labeled: a label further down a long edge lands
 * beside whatever else runs there and reads as theirs.
 */
function labelEdges(grid: Grid, d: Diagram, g: Graph, routes: Route[]) {
  const firstHop = new Map<DiagramEdge, number>()
  g.hops.forEach((h, k) => {
    if (h.first) firstHop.set(h.edge, k)
  })
  for (const e of d.edges) {
    const k = firstHop.get(e)
    if (!e.label || k === undefined) continue
    const { px, qx, top, bottom, laneY } = routes[k]!
    const lw = textWidth(e.label)
    const room = Math.abs(qx - px) - 1
    if (laneY !== undefined && room >= lw + 2) {
      const x = Math.min(px, qx) + 1 + Math.floor((room - lw - 2) / 2)
      const run = Array.from({ length: lw + 2 }, (_, i) => cellAt(grid, x + i, laneY))
      if (run.every(c => grid.borders[c] === 0 && !grid.text.has(c))) {
        write(grid, x, laneY, ` ${e.label} `)
        continue
      }
    }
    const text = ` ${clip(e.label, 14)}`
    const turn = laneY ?? bottom
    const spots: [number, number][] = []
    for (let y = top; y < turn; y++) spots.push([px + 1, y])
    for (let y = turn + 1; y < bottom; y++) spots.push([qx + 1, y])
    // One free cell past the text, so it never touches another line.
    const spot = spots.find(([x, y]) => isFree(grid, x, y, textWidth(text) + 1))
    if (spot) write(grid, spot[0], spot[1], text)
  }
}

function toRows(grid: Grid): string[] {
  const rows: string[] = []
  for (let y = 0; y < grid.height; y++) {
    let line = ''
    for (let x = 0; x < grid.width; x++) {
      const c = cellAt(grid, x, y)
      const lineBits = grid.lines[c]!, borderBits = grid.borders[c]!
      const crosses = (lineBits & (U | D) && borderBits & (L | R)) || (lineBits & (L | R) && borderBits & (U | D))
      line += grid.text.get(c) ?? (lineBits !== 0 ? (crosses ? '┼' : GLYPH[lineBits]) : GLYPH[borderBits]) ?? ' '
    }
    rows.push(line.trimEnd())
  }

  return rows
}

/**
 * A layered (Sugiyama-style) layout in terminal cells: ranks top-down, edges
 * that skip ranks broken into waypoints, ranks ordered by barycenter sweeps
 * keeping the order with the fewest crossings, x pulled toward neighbors, and
 * every hop routed orthogonally through the gap below its rank.
 */
export function layout(d: Diagram): Layout {
  if (d.nodes.length === 0) return { width: 0, height: 0, boxes: [], groups: [], rows: [] }
  const g = build(d)
  const { layers, posOf } = orderRanks(g)
  const blocks = blockGroups(g, layers, posOf)
  const { xs, gx, gw, width } = placeX(g, blocks)
  const ports = routePorts(g, xs)
  const { lane, gapH } = assignLanes(g, ports)
  const { rankY, height, groupEnds } = placeY(g, blocks, gapH)

  const groups: GroupRect[] = blocks.runs.map(run => {
    const [a, b] = blocks.span.get(run)!
    const y = rankY[a]! - 2
    return { name: groupName(run), x: gx.get(run)!, y, w: gw.get(run)!, h: rankY[b]! + BOX_H + 2 - y }
  })
  const routes: Route[] = g.hops.map((h, k) => {
    const above = g.items[h.a]!.rank
    const top = rankY[above]! + BOX_H
    const laneY = lane[k] === -1 ? undefined : top + 1 + (groupEnds[above] ? 1 : 0) + lane[k]!
    return { px: ports.outPort[k]!, qx: ports.inPort[k]!, top, bottom: rankY[g.items[h.b]!.rank]! - 1, laneY }
  })

  const grid: Grid = { width, height, lines: new Uint8Array(width * height), borders: new Uint8Array(width * height), text: new Map() }
  drawHops(grid, g, routes, xs, rankY)
  drawGroups(grid, groups)
  labelEdges(grid, d, g, routes)
  const boxes = g.items.flatMap((item, it) =>
    item.node ? [{ node: item.node, x: xs[it]!, y: rankY[item.rank]!, w: item.w, label: item.label, sub: item.sub }] : [],
  )

  return { width, height, boxes, groups, rows: toRows(grid) }
}

// ---- review -----------------------------------------------------------------

// A docked pane is rarely wider than this; past it the person has to pan.
const PANE_BUDGET = 100

/**
 * What the model reads after it draws: the laid-out size and what makes it hard
 * to read in a pane, each with the fix. Empty warnings mean it fits.
 */
export function review(d: Diagram): string {
  const l = layout(d)
  const ys = [...new Set(l.boxes.map(b => b.y))].sort((a, b) => a - b)
  const level = new Map(l.boxes.map(b => [b.node.id, ys.indexOf(b.y)]))
  const perLevel = ys.map(y => l.boxes.filter(b => b.y === y).length)
  const skips = d.edges.filter(e => Math.abs(level.get(e.to)! - level.get(e.from)!) > 1)
  const lonely = l.groups.filter(
    g => l.boxes.filter(b => b.node.group === g.name && b.x >= g.x && b.x < g.x + g.w && b.y >= g.y && b.y < g.y + g.h).length === 1,
  )
  const warnings: string[] = []
  if (l.width > PANE_BUDGET) {
    warnings.push(
      `${l.width} columns wide, past the ~${PANE_BUDGET} a pane shows (widest level: ${Math.max(...perLevel)} boxes): ` +
        'split it into an overview and detail diagrams, or move stores and externals into notes',
    )
  }
  if (skips.length > 2) {
    warnings.push(
      `${skips.length} edges skip levels (${skips.slice(0, 4).map(e => `${e.from}→${e.to}`).join(', ')}${skips.length > 4 ? ', …' : ''}): ` +
        'each runs a long line beside the boxes; keep the main flow and put side dependencies in notes',
    )
  }
  if (lonely.length > 0) {
    warnings.push(
      `group border around a single box (${[...new Set(lonely.map(g => g.name))].join(', ')}): ` +
        'a group should be a stage with 2+ boxes on consecutive levels; drop it or regroup',
    )
  }

  return warnings.length === 0
    ? `Laid out ${l.width}×${l.height}: fits the pane.`
    : `Laid out ${l.width}×${l.height}. To make it readable:\n- ${warnings.join('\n- ')}`
}
