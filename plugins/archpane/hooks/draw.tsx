import type { ClientElements } from 'claude-code'

import { BOX_H, type Layout } from './lib'

/** A laid-out diagram as plain data: what the pane hands its Client to draw. */
export type Drawing = {
  width: number
  mainW: number
  height: number
  rows: string[]
  boxes: { id: string; x: number; y: number; w: number; label: string; sub: string; color?: string }[]
}

export const toDrawing = (l: Layout, color: (status?: string) => string | undefined): Drawing => ({
  width: l.width,
  mainW: l.mainW,
  height: l.height,
  rows: l.rows,
  boxes: l.boxes.map(b => {
    const c = color(b.node.status)
    // Client props are JSON: a box with no status has no color key at all.
    return { id: b.node.id, x: b.x, y: b.y, w: b.w, label: b.label, sub: b.sub, ...(c === undefined ? {} : { color: c }) }
  }),
})

/**
 * The diagram in the flow, so a vertical scroll moves all of it: each rank is a
 * row of spacers and boxes with the right-hand channel beside it, the rest are
 * edge rows. `panX` columns are cut off the left inside a `cols`-wide window.
 */
export function draw({ Box, Text }: Pick<ClientElements, 'Box' | 'Text'>, d: Drawing, panX: number, cols: number) {
  const byY = new Map<number, Drawing['boxes']>()
  for (const b of d.boxes) byY.set(b.y, [...(byY.get(b.y) ?? []), b])

  const lines = []
  for (let y = 0; y < d.height; y++) {
    const rank = byY.get(y)
    if (rank === undefined) {
      lines.push(<Text dimColor>{d.rows[y] || ' '}</Text>)
      continue
    }
    let at = 0
    const cells = []
    for (const b of rank) {
      if (b.x > at) cells.push(<Box width={b.x - at} flexShrink={0} />)
      cells.push(
        <Box
          key={`n:${b.id}`}
          width={b.w}
          height={BOX_H}
          flexShrink={0}
          flexDirection="column"
          paddingX={1}
          borderStyle="round"
          borderColor={b.color}
          hover={{ scope: `n:${b.id}`, borderStyle: 'double' }}
        >
          <Text bold wrap="truncate">{b.label}</Text>
          <Text dimColor wrap="truncate">{b.sub}</Text>
        </Box>,
      )
      at = b.x + b.w
    }
    if (d.width > d.mainW) {
      cells.push(<Box width={d.mainW - at} flexShrink={0} />)
      cells.push(
        <Box flexDirection="column" flexShrink={0}>
          {d.rows.slice(y, y + BOX_H).map(r => (
            <Text dimColor>{r.slice(d.mainW) || ' '}</Text>
          ))}
        </Box>,
      )
    }
    lines.push(<Box flexDirection="row" height={BOX_H}>{cells}</Box>)
    y += BOX_H - 1
  }

  return (
    <Box width={cols} overflow="hidden">
      <Box flexDirection="column" width={d.width} flexShrink={0} marginLeft={panX === 0 ? 0 : -panX}>
        {lines}
      </Box>
    </Box>
  )
}
