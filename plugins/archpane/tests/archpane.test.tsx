import type { On } from 'claude-code'
import { expect, test } from 'claude-code/testing'

import { screen, toDrawing } from '../hooks/draw'
import { BOX_H, layout } from '../hooks/lib'

const TOOL = 'mcp__archpane__diagram'
const diagram = {
  title: 'Orders',
  nodes: [
    { id: 'api', label: 'Orders API', kind: 'service', status: 'done' },
    { id: 'worker', kind: 'worker', status: 'building' },
    { id: 'queue', kind: 'sqs' },
    { id: 'db', kind: 'dynamo', status: 'planned' },
  ],
  edges: [
    { from: 'api', to: 'queue', label: 'enqueue' },
    { from: 'queue', to: 'worker' },
    { from: 'worker', to: 'db' },
    { from: 'api', to: 'db', label: 'reads' },
    { from: 'db', to: 'api' },
  ],
}

// The engine's own answers the module leans on: the repo root, a store, a pane that seats.
const engine = (on: On) => {
  const store = new Map<string, unknown>()
  on('session.root', () => ({ value: '/repo' }))
  on('store.get', (_$, e) => ({ value: store.get(e.key) }))
  on('store.set', (_$, e) => {
    store.set(e.key, e.value)
    return { value: undefined }
  })
  on('store.delete', (_$, e) => {
    store.delete(e.key)
    return { value: undefined }
  })
  on('store.keys', () => ({ value: [...store.keys()] }))
  on('ui.open', () => ({ value: { isPlaced: true as const } }))
}

test('layout ranks top-down, keeps edges out of boxes, and gives every edge one arrowhead', () => {
  const l = layout(diagram as never)
  const y = (id: string) => l.boxes.find(b => b.node.id === id)!.y
  expect(y('api') < y('queue') && y('queue') < y('worker') && y('worker') < y('db')).toBe(true)
  for (const b of l.boxes) {
    for (let r = b.y; r < b.y + BOX_H; r++) expect((l.rows[r] ?? '').slice(b.x, b.x + b.w).trim()).toBe('')
  }
  const all = l.rows.join('\n')
  // Four edges point down; db→api closes a cycle, is laid out reversed and points up.
  expect(all.split('▼').length - 1).toBe(4)
  expect(all.split('▲').length - 1).toBe(1)
})

// What a drawn tree shows, row by row: Text runs joined.
type El = string | { children?: El[] }
const textOf = (el: El): string => (typeof el === 'string' ? el : (el.children ?? []).map(textOf).join(''))
const shown = async (ui: { drawn: (s: { in: string }) => Promise<unknown> }) =>
  ((await ui.drawn({ in: 'canvas' })) as { children: El[] }).children.map(r => textOf(r).trimEnd())

test('patch rejects an edge to an unknown node and leaves the diagram alone', async ($, on) => {
  engine(on)
  await $.tool.call({ tool: TOOL, op: 'set', name: 't1', diagram })
  const bad = await $.tool.call({ tool: TOOL, op: 'patch', name: 't1', edges: [{ from: 'api', to: 'nope' }] })
  expect(bad.deny).toMatch(/unknown node "nope"/)
  const got = await $.tool.call({ tool: TOOL, op: 'get', name: 't1' })
  expect(JSON.parse(String(got.result)).diagram.nodes.length).toBe(4)
})

test('patch merges nodes, removing a node drops its edges, and it persists', async ($, on) => {
  engine(on)
  await $.tool.call({ tool: TOOL, op: 'set', name: 't2', diagram })
  await $.tool.call({ tool: TOOL, op: 'patch', name: 't2', nodes: [{ id: 'worker', status: 'done' }], removeNodes: ['queue'] })
  const got = JSON.parse(String((await $.tool.call({ tool: TOOL, op: 'get', name: 't2' })).result))
  expect(got.diagram.nodes.find((n: { id: string }) => n.id === 'worker')).toEqual({ id: 'worker', kind: 'worker', status: 'done' })
  expect(got.diagram.edges.some((e: { from: string; to: string }) => e.from === 'queue' || e.to === 'queue')).toBe(false)
  const list = JSON.parse(String((await $.tool.call({ tool: TOOL, op: 'list' })).result))
  expect(list.diagrams).toContain('t2')
})

for (const surface of ['terminal', 'desktop'] as const) {
  test(`pane draws every component on ${surface}`, async ($, on) => {
    engine(on)
    await $.tool.call({ tool: TOOL, op: 'set', name: 'ui', diagram })
    const ui = await $.ui.mount({
      plugin: 'archpane',
      surface,
      component: 'Pane',
      requestId: 'archpane',
      props: { title: 'Diagram', isFocused: false, bodyColumns: 100, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
    })
    for (const text of ['Orders API', 'worker', 'queue', 'db']) expect(await ui.find({ type: 'Text', text, in: 'canvas' })).toBeDefined()
  })
}

test('dragging the diagram pans it sideways, showing exactly that slice, and stops at its edge', async ($, on) => {
  engine(on)
  await $.tool.call({ tool: TOOL, op: 'set', name: 'pan', diagram })
  const full = screen(toDrawing(layout(diagram as never), () => undefined))
  const width = layout(diagram as never).width
  const ui = await $.ui.mount({
    plugin: 'archpane',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'archpane',
    props: { title: 'Diagram', isFocused: true, bodyColumns: 10, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
  })
  const window = (pan: number) => full.map(r => r.padEnd(width).slice(pan, pan + 10).trimEnd())
  const api = layout(diagram as never).boxes.find(b => b.node.id === 'api')!
  const start = Math.max(0, Math.min(width - 10, Math.round(api.x + api.w / 2 - 5)))

  // It opens centered on the top rank (api alone here), not at column 0.
  expect(await shown(ui)).toEqual(window(start))
  await ui.pointer({ in: 'canvas', type: 'down', x: 8, y: 0, button: 'left' })
  await ui.pointer({ in: 'canvas', type: 'move', x: 3, y: 0, button: 'left' })
  expect(await shown(ui)).toEqual(window(Math.min(width - 10, start + 5)))
  await ui.pointer({ in: 'canvas', type: 'move', x: 200, y: 0, button: 'left' })
  expect(await shown(ui)).toEqual(window(0))
  await ui.pointer({ in: 'canvas', type: 'move', x: -200, y: 0, button: 'left' })
  await ui.pointer({ in: 'canvas', type: 'up', x: -200, y: 0, button: 'left' })
  expect(await shown(ui)).toEqual(window(width - 10))
})

test('clicking a box puts a reference to it in the prompt and highlights it; a drag does not', async ($, on) => {
  engine(on)
  const filled: string[] = []
  on('prompt.fill', (_$, e) => {
    filled.push(e.text)
    return { isFilled: true as const, box: { text: e.text, cursor: e.text.length } }
  })
  await $.tool.call({ tool: TOOL, op: 'set', name: 'click', diagram })
  const ui = await $.ui.mount({
    plugin: 'archpane',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'archpane',
    props: { title: 'Diagram', isFocused: true, bodyColumns: 100, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
  })
  const api = layout(diagram as never).boxes.find(b => b.node.id === 'api')!

  await ui.pointer({ in: 'canvas', type: 'down', x: api.x + 2, y: api.y + 1, button: 'left' })
  await ui.pointer({ in: 'canvas', type: 'move', x: api.x + 12, y: api.y + 1, button: 'left' })
  await ui.pointer({ in: 'canvas', type: 'up', x: api.x + 12, y: api.y + 1, button: 'left' })
  expect(filled).toEqual([])

  await ui.pointer({ in: 'canvas', type: 'down', x: api.x + 2, y: api.y + 1, button: 'left' })
  await ui.pointer({ in: 'canvas', type: 'up', x: api.x + 2, y: api.y + 1, button: 'left' })
  expect(filled).toEqual(['[diagram click: api] '])
  const cyan = (await ui.findAll({ type: 'Text', in: 'canvas' })).filter(t => (t.props as { color?: string }).color === 'cyan')
  expect(cyan.map(t => t.text)).toContain(`╭${'─'.repeat(api.w - 2)}╮`)
  expect(cyan.every(t => /^[╭╮╰╯─│]+$/.test(t.text))).toBe(true)
})
