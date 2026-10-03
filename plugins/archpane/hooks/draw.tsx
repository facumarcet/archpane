import type { ClientElements } from 'claude-code'

import { BOX_H, cells, textWidth, type Layout } from './lib'

/** A laid-out diagram as plain data: what the pane hands its Client to draw. */
export type Drawing = {
  width: number
  height: number
  rows: string[]
  boxes: { id: string; x: number; y: number; w: number; label: string; sub: string; color?: string; detail?: string }[]
  groups: { name: string; x: number; y: number; w: number; h: number }[]
}

export const toDrawing = (l: Layout, color: (status?: string) => string | undefined): Drawing => ({
  width: l.width,
  height: l.height,
  rows: l.rows,
  groups: l.groups,
  boxes: l.boxes.map(b => {
    const c = color(b.node.status)
    // Client props are JSON: a missing value has no key at all.
    return {
      id: b.node.id, x: b.x, y: b.y, w: b.w, label: b.label, sub: b.sub,
      ...(c === undefined ? {} : { color: c }),
      ...(b.node.detail ? { detail: b.node.detail } : {}),
    }
  }),
})

// What each cell is: an edge cell, a group border, the menu's border or item `i`
// (MENU_ITEM - i), or part of box `i` (its border, label row or sub row).
const EDGE = -1
const GROUP = -2
const MENU = -3
const MENU_ITEM = -10

/** A box's right-click menu, at diagram cell (x, y): its top-left corner. */
export type Menu = { x: number; y: number; items: string[] }
export const menuSize = (items: string[]) => ({ w: Math.max(...items.map(textWidth)) + 4, h: items.length + 2 })

// A line of cells: the text, padded with spaces to `n` cells.
const pad = (text: string, n: number) => [...cells(text), ...new Array<string>(Math.max(0, n - textWidth(text))).fill(' ')]
const BORDER = 0, LABEL = 1, SUB = 2
const cellOf = (box: number, part: number) => box * 3 + part

/** Paints the boxes over the edge rows, and a menu over those: every cell's glyph and owner. */
export function paint(d: Drawing, menu?: Menu): { chars: string[][]; owner: number[][] } {
  // A menu may reach past a small diagram: the grid grows to hold it.
  const { w: mw, h: mh } = menu ? menuSize(menu.items) : { w: 0, h: 0 }
  const W = Math.max(d.width, menu ? menu.x + mw : 0)
  const H = Math.max(d.height, menu ? menu.y + mh : 0)
  const chars = Array.from({ length: H }, (_, y) => pad(d.rows[y] ?? '', W))
  const owner = Array.from({ length: H }, () => new Array<number>(W).fill(EDGE))
  // `?? []`: after a hot reload the canvas can still hold a drawing made before groups existed.
  for (const g of d.groups ?? []) {
    for (let y = g.y; y < g.y + g.h; y++) {
      for (let x = g.x; x < g.x + g.w; x++) {
        if (y === g.y || y === g.y + g.h - 1 || x === g.x || x === g.x + g.w - 1) owner[y]![x] = GROUP
      }
    }
  }
  d.boxes.forEach((b, i) => {
    const lines = [
      ['╭', ...pad('', b.w - 2).fill('─'), '╮'],
      ['│', ' ', ...pad(b.label, b.w - 4), ' ', '│'],
      ['│', ' ', ...pad(b.sub, b.w - 4), ' ', '│'],
      ['╰', ...pad('', b.w - 2).fill('─'), '╯'],
    ]
    for (let dy = 0; dy < BOX_H; dy++) {
      lines[dy]!.forEach((c, dx) => {
        const edge = dy === 0 || dy === BOX_H - 1 || dx === 0 || dx === b.w - 1
        chars[b.y + dy]![b.x + dx] = c
        owner[b.y + dy]![b.x + dx] = cellOf(i, edge ? BORDER : dy === 1 ? LABEL : SUB)
      })
    }
  })

  if (menu) {
    const lines = [
      ['╭', ...pad('', mw - 2).fill('─'), '╮'],
      ...menu.items.map(i => ['│', ' ', ...pad(i, mw - 4), ' ', '│']),
      ['╰', ...pad('', mw - 2).fill('─'), '╯'],
    ]
    lines.forEach((line, dy) => {
      line.forEach((c, dx) => {
        const y = menu.y + dy, x = menu.x + dx
        chars[y]![x] = c
        const inside = dy > 0 && dy < mh - 1 && dx > 0 && dx < mw - 1
        owner[y]![x] = inside ? MENU_ITEM - (dy - 1) : MENU
      })
    })
  }

  return { chars, owner }
}

/** The painted diagram as plain lines, for tests and debugging. */
export const screen = (d: Drawing) => paint(d).chars.map(r => r.join('').trimEnd())

/**
 * The diagram as rows of sibling Text runs, cut to columns `panX`..`panX+cols`
 * by slicing, not by the surface's clipping. Every run of a box joins its hover
 * group (a Text nested in a Text could not heat it); the `picked` box is cyan.
 */
/** One row's runs inside the window: consecutive cells with one owner, as drawn. */
function runsOf(chars: string[][], owner: number[][], y: number, panX: number, end: number) {
  const line = chars[y]!
  const runs: { who: number; text: string }[] = []
  for (let x = panX; x < end; ) {
    const who = owner[y]![x]!
    let to = x + 1
    while (to < end && owner[y]![to] === who) to++
    // A wide character cut by the window's edge shows as a blank, not half a glyph.
    const run = line.slice(x, to)
    if (x === panX && run[0] === '') run[0] = ' '
    if (to === end && line[to] === '') run[run.length - 1] = ' '
    runs.push({ who, text: run.join('') })
    x = to
  }
  return runs
}

// What a run costs once serialized, past its text: the element and its props.
const RUN_COST = 110
const ROW_COST = 40

/**
 * About how many characters the drawing serializes to, as data handed to the canvas and as
 * the tree it draws in a `cols`-wide window. The engine refuses either past 100,000.
 */
export function drawnSize(d: Drawing, cols: number): { data: number; tree: number } {
  const { chars, owner } = paint(d)
  const end = Math.min(chars[0]?.length ?? 0, cols)
  let tree = 0
  for (let y = 0; y < chars.length; y++) {
    tree += ROW_COST
    for (const r of runsOf(chars, owner, y, 0, end)) tree += RUN_COST + r.text.length
  }
  return { data: JSON.stringify(d).length, tree }
}

/**
 * The diagram as rows of sibling Text runs, cut to columns `panX`..`panX+cols`
 * by slicing, not by the surface's clipping. Every run of a box joins its hover
 * group (a Text nested in a Text could not heat it); the `picked` box is cyan.
 */
export function draw(
  { Box, Text }: Pick<ClientElements, 'Box' | 'Text'>,
  d: Drawing,
  panX: number,
  cols: number,
  picked?: string,
  menu?: Menu,
) {
  const { chars, owner } = paint(d, menu)
  const end = Math.min(chars[0]?.length ?? 0, panX + cols)

  const rows = chars.map((_, y) => {
    const runs = runsOf(chars, owner, y, panX, end).map(({ who, text }) => {
      if (who === EDGE) return <Text dimColor>{text}</Text>
      if (who === GROUP) return <Text color="blue">{text}</Text>
      if (who === MENU) return <Text color="cyan">{text}</Text>
      if (who <= MENU_ITEM) {
        return (
          <Text bold hover={{ scope: `menu:${MENU_ITEM - who}`, inverse: true }}>
            {text}
          </Text>
        )
      }
      const b = d.boxes[Math.floor(who / 3)]!
      const scope = `n:${b.id}`
      const isPicked = b.id === picked
      const part = who % 3
      if (part === BORDER) {
        const color = isPicked ? 'cyan' : b.color
        return (
          <Text {...(color ? { color } : {})} bold={isPicked} hover={{ scope, color: 'cyan', bold: true }}>
            {text}
          </Text>
        )
      }
      if (part === LABEL) {
        return (
          <Text bold hover={{ scope, color: 'cyan' }}>
            {text}
          </Text>
        )
      }
      return (
        <Text dimColor hover={{ scope }}>
          {text}
        </Text>
      )
    })

    return runs.length === 0 ? <Text> </Text> : <Box flexDirection="row">{runs}</Box>
  })

  return <Box flexDirection="column">{rows}</Box>
}
