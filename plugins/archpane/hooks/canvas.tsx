import type { ClientModule } from 'claude-code'

import { draw, type Drawing } from './draw'

type Pan = { panX: number; drag?: { x: number; from: number } }

const KEY_STEP = 8

/** Draws the diagram and pans it sideways: drag with the left button, or h/l/←/→ once clicked. */
// `cols` is the pane's width, for before the region has been laid out.
const Canvas: ClientModule<Drawing & { cols: number }, Pan> = (d, s) => {
  const view = s.columns || d.cols
  const max = Math.max(0, d.width - view)
  const clamp = (x: number) => Math.max(0, Math.min(max, x))
  const now = () => s.state ?? { panX: 0 }

  s.onPointer(ev => {
    const pan = now()
    if (ev.type === 'down' && ev.button === 'left') s.setState({ panX: clamp(pan.panX), drag: { x: ev.x, from: clamp(pan.panX) } })
    else if (ev.type === 'move' && pan.drag) s.setState({ ...pan, panX: clamp(pan.drag.from - (ev.x - pan.drag.x)) })
    else if (ev.type === 'up' && pan.drag) s.setState({ panX: pan.panX })
  })
  s.onKey(ev => {
    const by = ev.key === 'h' || ev.key === 'left' ? -KEY_STEP : ev.key === 'l' || ev.key === 'right' ? KEY_STEP : 0
    if (by !== 0) s.setState({ panX: clamp(now().panX + by) })
  })

  return draw(s.elements, d, clamp(now().panX), view)
}

export default Canvas
