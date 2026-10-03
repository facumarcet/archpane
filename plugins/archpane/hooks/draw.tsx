import type { ClientElements } from 'claude-code'

import { BOX_H, type Layout } from './lib'

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
export const menuSize = (items: string[]) => ({ w: Math.max(...items.map(i => i.length)) + 4, h: items.length + 2 })
const BORDER = 0, LABEL = 1, SUB = 2
const cellOf = (box: number, part: number) => box * 3 + part

/** Paints the boxes over the edge rows, and a menu over those: every cell's glyph and owner. */
export function paint(d: Drawing, menu?: Menu): { chars: string[][]; owner: number[][] } {
  const chars = Array.from({ length: d.height }, (_, y) => [...(d.rows[y] ?? '').padEnd(d.width)])
  const owner = Array.from({ length: d.height }, () => new Array<number>(d.width).fill(EDGE))
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
      `╭${'─'.repeat(b.w - 2)}╮`,
      `│ ${b.label.padEnd(b.w - 4)} │`,
      `│ ${b.sub.padEnd(b.w - 4)} │`,
      `╰${'─'.repeat(b.w - 2)}╯`,
    ]
    for (let dy = 0; dy < BOX_H; dy++) {
      ;[...lines[dy]!].forEach((c, dx) => {
        const edge = dy === 0 || dy === BOX_H - 1 || dx === 0 || dx === b.w - 1
        chars[b.y + dy]![b.x + dx] = c
        owner[b.y + dy]![b.x + dx] = cellOf(i, edge ? BORDER : dy === 1 ? LABEL : SUB)
      })
    }
  })

  if (menu) {
    const { w, h } = menuSize(menu.items)
    const lines = [`╭${'─'.repeat(w - 2)}╮`, ...menu.items.map(i => `│ ${i.padEnd(w - 4)} │`), `╰${'─'.repeat(w - 2)}╯`]
    lines.forEach((line, dy) => {
      ;[...line].forEach((c, dx) => {
        const y = menu.y + dy, x = menu.x + dx
        if (y >= d.height || x >= d.width) return
        chars[y]![x] = c
        const inside = dy > 0 && dy < h - 1 && dx > 0 && dx < w - 1
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
export function draw(
  { Box, Text }: Pick<ClientElements, 'Box' | 'Text'>,
  d: Drawing,
  panX: number,
  cols: number,
  picked?: string,
  menu?: Menu,
) {
  const { chars, owner } = paint(d, menu)
  const end = Math.min(d.width, panX + cols)

  const rows = chars.map((line, y) => {
    const runs = []
    let x = panX
    while (x < end) {
      const who = owner[y]![x]!
      let to = x + 1
      while (to < end && owner[y]![to] === who) to++
      const text = line.slice(x, to).join('')
      if (who === EDGE) {
        runs.push(<Text dimColor>{text}</Text>)
      } else if (who === GROUP) {
        runs.push(<Text color="blue">{text}</Text>)
      } else if (who === MENU) {
        runs.push(<Text color="cyan">{text}</Text>)
      } else if (who <= MENU_ITEM) {
        runs.push(
          <Text bold hover={{ scope: `menu:${MENU_ITEM - who}`, inverse: true }}>
            {text}
          </Text>,
        )
      } else {
        const b = d.boxes[Math.floor(who / 3)]!
        const scope = `n:${b.id}`
        const isPicked = b.id === picked
        const part = who % 3
        if (part === BORDER) {
          const color = isPicked ? 'cyan' : b.color
          runs.push(
            <Text {...(color ? { color } : {})} bold={isPicked} hover={{ scope, color: 'cyan', bold: true }}>
              {text}
            </Text>,
          )
        } else if (part === LABEL) {
          runs.push(
            <Text bold hover={{ scope, color: 'cyan' }}>
              {text}
            </Text>,
          )
        } else {
          runs.push(
            <Text dimColor hover={{ scope }}>
              {text}
            </Text>,
          )
        }
      }
      x = to
    }

    return runs.length === 0 ? <Text> </Text> : <Box flexDirection="row">{runs}</Box>
  })

  return <Box flexDirection="column">{rows}</Box>
}
