import type { ClientModule } from 'claude-code'

import { draw, menuSize, type Drawing, type Menu } from './draw'
import { BOX_H } from './lib'

type Action = 'pick' | 'open' | 'copy'
type Open = Menu & { id: string; actions: Action[] }
type Pan = {
  // The diagram this state belongs to: another one starts fresh.
  name: string
  panX: number
  picked?: string
  menu?: Open
  drag?: { x: number; y: number; from: number }
  right?: { x: number; y: number }
}

const LABELS: Record<Action, string> = { pick: 'Ask about this', open: 'Open detail ▸', copy: 'Copy id' }

/**
 * Draws the diagram and turns the pointer into its actions, all without the
 * keyboard (a key listener would take it from the prompt):
 * - drag with the left button: pan sideways
 * - left click on a box: open its detail diagram if it has one, else ask about it
 * - right click on a box: a menu of everything a box can do; a left click picks
 *   an item, a click anywhere else closes it
 * Actions are posted to the hooks module as `{ pick | open | copy: id }`.
 */
// `cols` and `regionRows` are the region's size, for before it has been laid out.
const Canvas: ClientModule<Drawing & { cols: number; regionRows: number; name: string }, Pan> = (d, s) => {
  const view = s.columns || d.cols
  const max = Math.max(0, d.width - view)
  const clamp = (x: number) => Math.max(0, Math.min(max, x))
  // Until the person pans, the window opens centered on the top rank: where the diagram starts.
  // The top rank sits lower when a group's border starts there: take the highest boxes.
  const minY = d.boxes.reduce((m, b) => Math.min(m, b.y), Infinity)
  const top = d.boxes.filter(b => b.y === minY)
  const start = top.length === 0 ? 0 : (Math.min(...top.map(b => b.x)) + Math.max(...top.map(b => b.x + b.w))) / 2
  // Saved state counts only when it exists and is for this diagram: after a hot reload the
  // props can predate `name`, and undefined === undefined would claim state that isn't there.
  const now = (): Pan =>
    s.state !== undefined && s.state.name === d.name ? s.state : { name: d.name, panX: clamp(Math.round(start - view / 2)) }
  const hit = (x: number, y: number, pan: number) =>
    d.boxes.find(b => y >= b.y && y < b.y + BOX_H && x + pan >= b.x && x + pan < b.x + b.w)
  const act = (action: Action, id: string) => s.post({ [action]: id })

  // A menu opens under the click, kept inside the diagram and the visible window.
  const menuAt = (box: Drawing['boxes'][number], x: number, y: number, pan: number): Open => {
    const actions: Action[] = box.detail ? ['pick', 'open', 'copy'] : ['pick', 'copy']
    const items = actions.map(a => LABELS[a])
    const { w, h } = menuSize(items)
    // The menu may reach past a small diagram (the grid grows for it), not past the region.
    const mx = Math.max(pan, Math.min(x + pan, pan + view - w))
    const my = Math.max(0, Math.min(y + 1, Math.max(d.height, s.rows || d.regionRows || 0) - h))
    return { id: box.id, actions, items, x: Math.max(0, mx), y: my }
  }
  const menuItem = (m: Open, x: number, y: number, pan: number) => {
    const { w } = menuSize(m.items)
    const i = y - m.y - 1
    return x + pan > m.x && x + pan < m.x + w - 1 && i >= 0 && i < m.actions.length ? m.actions[i] : undefined
  }

  s.onPointer(ev => {
    const pan = now()
    const at = clamp(pan.panX)
    if (ev.type === 'down' && ev.button === 'right') {
      s.setState({ ...pan, right: { x: ev.x, y: ev.y } })
    } else if (ev.type === 'up' && ev.button === 'right' && pan.right) {
      const box = hit(pan.right.x, pan.right.y, at)
      const { right: _, menu: __, ...rest } = pan
      s.setState(box ? { ...rest, menu: menuAt(box, pan.right.x, pan.right.y, at) } : rest)
    } else if (ev.type === 'down' && ev.button === 'left' && pan.menu) {
      // With a menu open, a left click picks an item or just closes it.
      const action = menuItem(pan.menu, ev.x, ev.y, at)
      if (action) act(action, pan.menu.id)
      s.setState({ name: pan.name, panX: pan.panX, ...(action === 'pick' ? { picked: pan.menu.id } : {}) })
    } else if (ev.type === 'down' && ev.button === 'left') {
      s.setState({ ...pan, panX: at, drag: { x: ev.x, y: ev.y, from: at } })
    } else if (ev.type === 'move' && pan.drag) {
      s.setState({ ...pan, panX: clamp(pan.drag.from - (ev.x - pan.drag.x)) })
    } else if (ev.type === 'up' && pan.drag) {
      const { x, y, from } = pan.drag
      const box = Math.abs(ev.x - x) <= 1 && Math.abs(ev.y - y) <= 1 ? hit(x, y, from) : undefined
      const { drag: _, ...rest } = pan
      if (box === undefined) {
        s.setState(rest)
      } else if (box.detail) {
        s.setState({ ...rest, panX: from })
        act('open', box.id)
      } else {
        s.setState({ ...rest, panX: from, picked: box.id })
        act('pick', box.id)
      }
    }
  })

  const pan = now()
  return draw(s.elements, d, clamp(pan.panX), view, pan.picked, pan.menu)
}

export default Canvas
