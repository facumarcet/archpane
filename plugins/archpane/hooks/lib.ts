import type { Diagram, DiagramEdge, DiagramNode, Status } from '../types'

export const STATUSES: readonly Status[] = ['planned', 'building', 'done', 'blocked']
const MAX_NODES = 300
const MAX_EDGES = 1000

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
  for (const n of p.nodes ?? []) nodes.set(n.id, { ...nodes.get(n.id), ...n })
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
    if (![n.label, n.kind, n.group, n.note].every(optStr)) return `node "${n.id}": label/kind/group/note must be strings`
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

export type Placed = { node: DiagramNode; x: number; y: number; w: number; label: string; sub: string }
export type Layout = { width: number; height: number; boxes: Placed[]; rows: string[] }

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)
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

const U = 1, D = 2, L = 4, R = 8
const GLYPH: Record<number, string> = {
  [U]: '│', [D]: '│', [U | D]: '│', [L]: '─', [R]: '─', [L | R]: '─',
  [D | R]: '╭', [D | L]: '╮', [U | R]: '╰', [U | L]: '╯',
  [U | D | R]: '├', [U | D | L]: '┤', [D | L | R]: '┬', [U | L | R]: '┴', [U | D | L | R]: '┼',
}

/** A box, or a waypoint (no node) a long edge passes through on its way down. */
type Item = { node?: DiagramNode; rank: number; w: number; label: string; sub: string }
/** One hop of an edge between adjacent ranks, item `a` above `b`. */
type Seg = { a: number; b: number; edge: DiagramEdge; rev: boolean; first: boolean; last: boolean }

/**
 * A layered (Sugiyama-style) layout in terminal cells: ranks top-down, edges
 * that skip ranks broken into waypoints, ranks ordered by barycenter sweeps
 * keeping the order with the fewest crossings, x pulled toward neighbors, and
 * every hop routed orthogonally through the gap below its rank.
 */
export function layout(d: Diagram): Layout {
  const edges = orient(d)
  const ranks = rank(d, edges)
  const depth = d.nodes.length === 0 ? 0 : Math.max(...ranks.values()) + 1

  const items: Item[] = d.nodes.map(n => {
    const sub = [n.kind, n.status].filter(Boolean).join(' · ')
    const w = Math.min(MAX_W, Math.max(MIN_W, (n.label ?? n.id).length + 4, sub.length + 4))
    return { node: n, rank: ranks.get(n.id)!, w, label: clip(n.label ?? n.id, w - 4), sub: clip(sub, w - 4) }
  })
  const itemOf = new Map(d.nodes.map((n, i) => [n.id, i]))
  const segs: Seg[] = []
  for (const e of edges) {
    let prev = itemOf.get(e.u)!
    const end = itemOf.get(e.v)!
    for (let r = items[prev]!.rank + 1; r <= items[end]!.rank; r++) {
      const next = r === items[end]!.rank ? end : items.push({ rank: r, w: 1, label: '', sub: '' }) - 1
      segs.push({ a: prev, b: next, edge: e.edge, rev: e.rev, first: r === items[itemOf.get(e.u)!]!.rank + 1, last: next === end })
      prev = next
    }
  }

  const ups: number[][] = items.map(() => [])
  const downs: number[][] = items.map(() => [])
  for (const s of segs) {
    ups[s.b]!.push(s.a)
    downs[s.a]!.push(s.b)
  }

  // Order within ranks: alternate down and up barycenter sweeps, keep the best.
  let layers: number[][] = Array.from({ length: depth }, () => [])
  items.forEach((it, i) => layers[it.rank]!.push(i))
  const posOf: number[] = new Array(items.length).fill(0)
  const index = () => layers.forEach(l => l.forEach((it, i) => (posOf[it] = i)))
  const segsBelow: Seg[][] = Array.from({ length: depth }, () => [])
  for (const s of segs) segsBelow[items[s.a]!.rank]!.push(s)
  const crossings = () => {
    let c = 0
    for (const ss of segsBelow) {
      for (let i = 0; i < ss.length; i++) {
        for (let j = i + 1; j < ss.length; j++) {
          const p = ss[i]!, q = ss[j]!
          if ((posOf[p.a]! - posOf[q.a]!) * (posOf[p.b]! - posOf[q.b]!) < 0) c++
        }
      }
    }
    return c
  }
  index()
  let best = crossings()
  let bestLayers = layers.map(l => [...l])
  for (let sweep = 0; sweep < SWEEPS && best > 0; sweep++) {
    const down = sweep % 2 === 0
    const nb = down ? ups : downs
    for (let k = 1; k < depth; k++) {
      const r = down ? k : depth - 1 - k
      const bary = new Map(layers[r]!.map(it => [it, nb[it]!.length > 0 ? avg(nb[it]!.map(n => posOf[n]!)) : posOf[it]!]))
      layers[r] = [...layers[r]!].sort((p, q) => bary.get(p)! - bary.get(q)!)
      layers[r]!.forEach((it, i) => (posOf[it] = i))
    }
    const c = crossings()
    if (c < best) {
      best = c
      bestLayers = layers.map(l => [...l])
    }
  }
  layers = bestLayers
  index()

  // x: pack each rank, then pull every item toward its neighbors' centers, keeping order and spacing.
  const xs: number[] = new Array(items.length).fill(0)
  const gap = (p: number, q: number) => (items[p]!.node && items[q]!.node ? H_GAP : D_GAP)
  const cx = (it: number) => xs[it]! + Math.floor(items[it]!.w / 2)
  const place = (l: number[], want: (it: number) => number) => {
    let min = -Infinity
    l.forEach((it, i) => {
      xs[it] = Math.max(Math.round(want(it)), min)
      min = xs[it]! + items[it]!.w + (i + 1 < l.length ? gap(it, l[i + 1]!) : 0)
    })
  }
  for (const l of layers) place(l, () => 0)
  for (let pass = 0; pass < 4; pass++) {
    const nb = pass % 2 === 0 ? ups : downs
    for (let k = 1; k < depth; k++) {
      const l = layers[pass % 2 === 0 ? k : depth - 1 - k]!
      place(l, it => (nb[it]!.length > 0 ? avg(nb[it]!.map(cx)) - Math.floor(items[it]!.w / 2) : xs[it]!))
    }
  }
  const minX = Math.min(...xs)
  for (let i = 0; i < xs.length; i++) xs[i] = xs[i]! - minX
  const width = Math.max(0, ...items.map((it, i) => xs[i]! + it.w))

  // Ports: a box spreads its hops across its width, ordered by where the other end is.
  const outPort: number[] = new Array(segs.length).fill(0)
  const inPort: number[] = new Array(segs.length).fill(0)
  const spread = (it: number, ks: number[], other: (k: number) => number, port: number[]) => {
    const { w, node } = items[it]!
    ;[...ks].sort((p, q) => other(p) - other(q)).forEach((k, i, all) => {
      port[k] = node ? Math.max(xs[it]! + 2, Math.min(xs[it]! + w - 3, xs[it]! + Math.round(((i + 1) * w) / (all.length + 1)))) : xs[it]!
    })
  }
  items.forEach((_, it) => {
    spread(it, segs.flatMap((s, k) => (s.a === it ? [k] : [])), k => cx(segs[k]!.b), outPort)
    spread(it, segs.flatMap((s, k) => (s.b === it ? [k] : [])), k => cx(segs[k]!.a), inPort)
  })
  // A box's only hop goes straight when the other end's port lands on that box anyway.
  const onBox = (it: number, x: number) => items[it]!.node !== undefined && x >= xs[it]! + 2 && x <= xs[it]! + items[it]!.w - 3
  segs.forEach((s, k) => {
    if (ups[s.b]!.length === 1 && onBox(s.b, outPort[k]!)) inPort[k] = outPort[k]!
    else if (downs[s.a]!.length === 1 && onBox(s.a, inPort[k]!)) outPort[k] = inPort[k]!
  })

  // Lanes: each bent hop gets a horizontal track in its gap. Where one hop drops into
  // the column another starts from, the starting one must turn first (a lane above),
  // or the two would share a vertical. Within that order, tracks pack where runs don't touch.
  const lane: number[] = new Array(segs.length).fill(-1)
  const gapH: number[] = new Array(Math.max(0, depth - 1)).fill(2)
  segsBelow.forEach((ss, g) => {
    if (g >= depth - 1) return
    const bent = ss.map(s => segs.indexOf(s)).filter(k => outPort[k] !== inPort[k])
    const lo = (k: number) => Math.min(outPort[k]!, inPort[k]!)
    const hi = (k: number) => Math.max(outPort[k]!, inPort[k]!)
    const above = new Map(bent.map(k => [k, bent.filter(o => o !== k && inPort[k] === outPort[o])]))
    const tracks: number[][] = []
    const left = new Set(bent)
    while (left.size > 0) {
      const ready = [...left].filter(k => above.get(k)!.every(o => !left.has(o)))
      // A cycle of such drops can't all be untangled: take the leftmost and accept the overlap.
      const k = (ready.length > 0 ? ready : [...left]).sort((p, q) => lo(p) - lo(q))[0]!
      left.delete(k)
      let at = Math.max(0, ...above.get(k)!.filter(o => lane[o] !== -1).map(o => lane[o]! + 1))
      while (tracks[at]?.some(o => !(hi(o) + 1 < lo(k) || hi(k) + 1 < lo(o)))) at++
      ;(tracks[at] ??= []).push(k)
      lane[k] = at
    }
    gapH[g] = Math.max(2, tracks.length + 2)
  })
  const rankY: number[] = [0]
  for (let r = 1; r < depth; r++) rankY.push(rankY[r - 1]! + BOX_H + gapH[r - 1]!)
  const height = depth === 0 ? 0 : rankY[depth - 1]! + BOX_H

  const mask = new Uint8Array(width * height)
  const overlay = new Map<number, string>()
  const put = (x: number, y: number, bits: number) => {
    if (x >= 0 && x < width && y >= 0 && y < height) mask[y * width + x]! |= bits
  }
  const seg = (x0: number, y0: number, x1: number, y1: number) => {
    if (x0 === x1) {
      const [a, b] = y0 < y1 ? [y0, y1] : [y1, y0]
      for (let y = a; y <= b; y++) put(x0, y, (y > a ? U : 0) | (y < b ? D : 0))
    } else {
      const [a, b] = x0 < x1 ? [x0, x1] : [x1, x0]
      for (let x = a; x <= b; x++) put(x, y0, (x > a ? L : 0) | (x < b ? R : 0))
    }
  }
  const top = (k: number) => rankY[items[segs[k]!.a]!.rank]! + BOX_H
  const bottom = (k: number) => rankY[items[segs[k]!.b]!.rank]! - 1
  const laneY = (k: number) => top(k) + 1 + lane[k]!

  items.forEach((it, i) => {
    if (!it.node) for (let y = rankY[it.rank]!; y < rankY[it.rank]! + BOX_H; y++) put(xs[i]!, y, U | D)
  })
  segs.forEach((s, k) => {
    const px = outPort[k]!, qx = inPort[k]!, y0 = top(k), y1 = bottom(k)
    const pts: [number, number][] = [[px, y0]]
    if (lane[k] !== -1) pts.push([px, laneY(k)], [qx, laneY(k)])
    pts.push([qx, y1])
    put(px, y0, U)
    for (let i = 1; i < pts.length; i++) seg(...pts[i - 1]!, ...pts[i]!)
    if (!items[s.b]!.node) put(qx, y1, D)
    if (s.last && !s.rev) overlay.set(y1 * width + qx, '▼')
    if (s.first && s.rev) overlay.set(y0 * width + px, '▲')
  })

  // Labels go on after every line: centered on a bent hop's run where it fits,
  // else beside a vertical, only into free cells. The rest show in the hover detail.
  const free = (y: number, x: number, n: number) =>
    x + n <= width && Array.from({ length: n }, (_, i) => y * width + x + i).every(at => mask[at] === 0 && !overlay.has(at))
  const write = (y: number, x: number, text: string) => [...text].forEach((c, i) => overlay.set(y * width + x + i, c))
  for (const e of d.edges) {
    if (!e.label) continue
    const chain = segs.flatMap((s, k) => (s.edge === e ? [k] : []))
    const tryPlace = () => {
      for (const k of chain) {
        const px = outPort[k]!, qx = inPort[k]!
        const room = Math.abs(qx - px) - 1
        if (lane[k] !== -1 && room >= e.label!.length + 2) {
          const x = Math.min(px, qx) + 1 + Math.floor((room - e.label!.length - 2) / 2)
          write(laneY(k), x, ` ${e.label} `)
          return
        }
        const text = ` ${clip(e.label!, 14)}`
        const spots: [number, number][] = []
        const turn = lane[k] === -1 ? bottom(k) : laneY(k)
        for (let y = top(k); y < turn; y++) spots.push([y, px + 1])
        for (let y = turn + 1; y < bottom(k); y++) spots.push([y, qx + 1])
        const spot = spots.find(([y, x]) => free(y, x, text.length))
        if (spot) {
          write(spot[0], spot[1], text)
          return
        }
      }
    }
    tryPlace()
  }

  const rows: string[] = []
  for (let y = 0; y < height; y++) {
    let line = ''
    for (let x = 0; x < width; x++) line += overlay.get(y * width + x) ?? GLYPH[mask[y * width + x]!] ?? ' '
    rows.push(line.trimEnd())
  }
  const boxes = items.flatMap((it, i) => (it.node ? [{ node: it.node, x: xs[i]!, y: rankY[it.rank]!, w: it.w, label: it.label, sub: it.sub }] : []))

  return { width, height, boxes, rows }
}
