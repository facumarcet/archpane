import type { ClientModule } from 'claude-code'

import { draw, type Drawing } from './draw'
import { BOX_H } from './lib'

type Pan = { panX: number; picked?: string; drag?: { x: number; y: number; from: number } }

/**
 * Draws the diagram and pans it sideways by dragging with the left button. A press
 * that ends where it began is a click: on a box it picks it and posts `{ pick: id }`
 * to the hooks module. No key listener, so a click leaves the keyboard on the prompt.
 */
// `cols` is the pane's width, for before the region has been laid out.
const Canvas: ClientModule<Drawing & { cols: number }, Pan> = (d, s) => {
  const view = s.columns || d.cols
  const max = Math.max(0, d.width - view)
  const clamp = (x: number) => Math.max(0, Math.min(max, x))
  const now = (): Pan => s.state ?? { panX: 0 }
  const hit = (x: number, y: number, pan: number) =>
    d.boxes.find(b => y >= b.y && y < b.y + BOX_H && x + pan >= b.x && x + pan < b.x + b.w)

  s.onPointer(ev => {
    const pan = now()
    if (ev.type === 'down' && ev.button === 'left') {
      const from = clamp(pan.panX)
      s.setState({ ...pan, panX: from, drag: { x: ev.x, y: ev.y, from } })
    } else if (ev.type === 'move' && pan.drag) {
      s.setState({ ...pan, panX: clamp(pan.drag.from - (ev.x - pan.drag.x)) })
    } else if (ev.type === 'up' && pan.drag) {
      const { x, y, from } = pan.drag
      const box = Math.abs(ev.x - x) <= 1 && Math.abs(ev.y - y) <= 1 ? hit(x, y, from) : undefined
      if (box === undefined) {
        s.setState({ panX: pan.panX, picked: pan.picked })
        return
      }
      s.setState({ panX: from, picked: box.id })
      s.post({ pick: box.id })
    }
  })

  const pan = now()
  return draw(s.elements, d, clamp(pan.panX), view, pan.picked)
}

export default Canvas
