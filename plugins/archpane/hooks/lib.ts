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
const MIN_W = 10
const MAX_W = 26

export type Placed = { node: DiagramNode; x: number; y: number; w: number; label: string; sub: string }
export type Layout = { width: number; mainW: number; height: number; boxes: Placed[]; rows: string[] }

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)

/** Ranks over the graph with cycle edges set aside: each node one below its deepest parent. */
function rank(d: Diagram): Map<string, number> {
  const out = new Map<string, string[]>(d.nodes.map(n => [n.id, []]))
  for (const e of d.edges) if (e.from !== e.to) out.get(e.from)!.push(e.to)

  // DFS: an edge into a node still on the stack closes a cycle and does not rank.
  const forward: [string, string][] = []
  const state = new Map<string, 1 | 2>()
  const visit = (id: string) => {
    state.set(id, 1)
    for (const to of out.get(id)!) {
      if (state.get(to) === 1) continue
      forward.push([id, to])
      if (!state.has(to)) visit(to)
    }
    state.set(id, 2)
  }
  for (const n of d.nodes) if (!state.has(n.id)) visit(n.id)

  const indeg = new Map(d.nodes.map(n => [n.id, 0]))
  for (const [, to] of forward) indeg.set(to, indeg.get(to)! + 1)
  const r = new Map(d.nodes.map(n => [n.id, 0]))
  const queue = d.nodes.filter(n => indeg.get(n.id) === 0).map(n => n.id)
  while (queue.length > 0) {
    const id = queue.shift()!
    for (const [from, to] of forward) {
      if (from !== id) continue
      r.set(to, Math.max(r.get(to)!, r.get(id)! + 1))
      indeg.set(to, indeg.get(to)! - 1)
      if (indeg.get(to) === 0) queue.push(to)
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

/**
 * Lays the diagram out top-down in terminal cells: one row of boxes per rank,
 * edges routed orthogonally through the gaps between ranks. Edges that skip a
 * rank, go back up, or stay in one rank run down a channel to the right.
 */
// ponytail: one barycenter pass for ordering, no crossing minimization; add sweeps if real diagrams tangle.
export function layout(d: Diagram): Layout {
  const ranks = rank(d)
  const depth = d.nodes.length === 0 ? 0 : Math.max(...ranks.values()) + 1
  const rows: DiagramNode[][] = Array.from({ length: depth }, () => [])
  for (const n of d.nodes) rows[ranks.get(n.id)!]!.push(n)

  const order = new Map<string, number>()
  const parents = new Map<string, string[]>()
  for (const e of d.edges) if (ranks.get(e.from)! < ranks.get(e.to)!) parents.set(e.to, [...(parents.get(e.to) ?? []), e.from])
  rows.forEach((row, r) => {
    if (r > 0) {
      const bary = (n: DiagramNode) => {
        const ps = (parents.get(n.id) ?? []).map(p => order.get(p)!)
        return ps.length === 0 ? Infinity : ps.reduce((a, b) => a + b, 0) / ps.length
      }
      row.sort((a, b) => bary(a) - bary(b))
    }
    row.forEach((n, i) => order.set(n.id, i))
  })

  const size = (n: DiagramNode) => {
    const sub = [n.kind, n.status].filter(Boolean).join(' · ')
    const w = Math.min(MAX_W, Math.max(MIN_W, (n.label ?? n.id).length + 4, sub.length + 4))
    return { w, label: clip(n.label ?? n.id, w - 4), sub: clip(sub, w - 4) }
  }
  const sized = rows.map(row => row.map(n => ({ node: n, ...size(n) })))
  const rowW = sized.map(row => row.reduce((a, b) => a + b.w, 0) + H_GAP * Math.max(0, row.length - 1))
  const mainW = Math.max(0, ...rowW)

  // Gap g sits above rank g (g = depth is below the last). Lanes are its horizontal tracks.
  const lanes = Array.from({ length: depth + 1 }, () => new Map<string, number>())
  const lane = (g: number, key: string) => {
    const l = lanes[g]!
    if (!l.has(key)) l.set(key, l.size)
    return key
  }
  type Route = { e: DiagramEdge; exit: string; entry?: string; channel?: number }
  const routes: Route[] = []
  let channels = 0
  const cx = new Map<string, number>()
  sized.forEach((row, r) => {
    let x = Math.floor((mainW - rowW[r]!) / 2)
    for (const b of row) {
      cx.set(b.node.id, x + Math.floor(b.w / 2))
      x += b.w + H_GAP
    }
  })
  for (const e of d.edges) {
    if (e.from === e.to) continue
    const rs = ranks.get(e.from)!, rt = ranks.get(e.to)!
    if (rt === rs + 1) {
      routes.push({ e, exit: cx.get(e.from) === cx.get(e.to) ? '' : lane(rs + 1, `out:${e.from}`) })
    } else {
      routes.push({ e, exit: lane(rs + 1, `out:${e.from}`), entry: lane(rt, `in:${e.to}`), channel: channels++ })
    }
  }

  const gapH = lanes.map((l, g) => (l.size > 0 ? l.size + 2 : g === 0 || g === depth ? 0 : 2))
  const gapTop: number[] = []
  const rankY: number[] = []
  let y = 0
  for (let g = 0; g <= depth; g++) {
    gapTop.push(y)
    y += gapH[g]!
    if (g < depth) {
      rankY.push(y)
      y += BOX_H
    }
  }
  const height = y
  const width = mainW + (channels > 0 ? channels * 2 + 1 : 0)

  const boxes: Placed[] = sized.flatMap((row, r) => {
    let x = Math.floor((mainW - rowW[r]!) / 2)
    return row.map(b => {
      const placed = { ...b, x, y: rankY[r]! }
      x += b.w + H_GAP
      return placed
    })
  })

  const mask = new Uint8Array(width * height)
  const put = (x: number, y: number, bits: number) => {
    if (x >= 0 && x < width && y >= 0 && y < height) mask[y * width + x]! |= bits
  }
  const seg = (x0: number, y0: number, x1: number, y1: number) => {
    if (x0 === x1) {
      const [a, b] = y0 < y1 ? [y0, y1] : [y1, y0]
      for (let yy = a; yy <= b; yy++) put(x0, yy, (yy > a ? U : 0) | (yy < b ? D : 0))
    } else {
      const [a, b] = x0 < x1 ? [x0, x1] : [x1, x0]
      for (let xx = a; xx <= b; xx++) put(xx, y0, (xx > a ? L : 0) | (xx < b ? R : 0))
    }
  }
  const overlay = new Map<number, string>()
  const laneRow = (g: number, key: string) => gapTop[g]! + 1 + lanes[g]!.get(key)!

  for (const { e, exit, entry, channel } of routes) {
    const rs = ranks.get(e.from)!, rt = ranks.get(e.to)!
    const sx = cx.get(e.from)!, tx = cx.get(e.to)!
    const sy = rankY[rs]! + BOX_H
    const arrowY = rankY[rt]! - 1
    const pts: [number, number][] = [[sx, sy]]
    if (channel === undefined) {
      if (exit !== '') pts.push([sx, laneRow(rs + 1, exit)], [tx, laneRow(rs + 1, exit)])
    } else {
      const chx = mainW + 1 + channel * 2
      const ex = laneRow(rs + 1, exit), en = laneRow(rt, entry!)
      pts.push([sx, ex], [chx, ex], [chx, en], [tx, en])
    }
    pts.push([tx, arrowY])
    put(sx, sy, U)
    for (let i = 1; i < pts.length; i++) seg(...pts[i - 1]!, ...pts[i]!)
    overlay.set(arrowY * width + tx, '▼')
  }

  // Labels go on after every line: on their horizontal run when it fits, else beside
  // the arrow's stem, and only into free cells. The rest show in the hover detail.
  for (const { e, exit, channel } of routes) {
    if (!e.label) continue
    const rs = ranks.get(e.from)!, rt = ranks.get(e.to)!
    const sx = cx.get(e.from)!, tx = cx.get(e.to)!
    const onLane = channel === undefined && exit !== ''
    const room = onLane ? Math.abs(tx - sx) - 1 : 0
    const fits = room >= e.label.length + 2
    const ly = fits ? laneRow(rs + 1, exit) : rankY[rt]! - 2
    const text = fits ? ` ${e.label} ` : ` ${clip(e.label, 14)}`
    const start = fits ? Math.min(sx, tx) + 1 + Math.floor((room - text.length) / 2) : tx + 1
    const cells = [...text].map((_, i) => ly * width + start + i)
    const free = start + text.length <= width && cells.every(at => mask[at] === 0 && !overlay.has(at))
    if (fits ? cells.every(at => !overlay.has(at)) : free) cells.forEach((at, i) => overlay.set(at, text[i]!))
  }

  const out: string[] = []
  for (let yy = 0; yy < height; yy++) {
    let line = ''
    for (let xx = 0; xx < width; xx++) {
      const at = yy * width + xx
      line += overlay.get(at) ?? GLYPH[mask[at]!] ?? ' '
    }
    out.push(line.trimEnd())
  }

  return { width, mainW, height, boxes, rows: out }
}
