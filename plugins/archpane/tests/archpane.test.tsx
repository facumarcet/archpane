import type { On } from 'claude-code'
import { expect, test } from 'claude-code/testing'

import { screen, toDrawing } from '../hooks/draw'
import { BOX_H, layout, review } from '../hooks/lib'

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

test('groups get one border per run of ranks that holds their members, and nothing else', () => {
  const grouped = {
    nodes: [
      { id: 'web', group: 'edge' },
      { id: 'api', group: 'core' },
      { id: 'jobs', group: 'core' },
      { id: 'queue', group: 'infra' },
      { id: 'worker', group: 'core' },
      { id: 'db', group: 'infra' },
      { id: 'cdn', group: 'edge' },
      { id: 'stray' },
    ],
    edges: [
      { from: 'web', to: 'api' },
      { from: 'api', to: 'jobs' },
      { from: 'api', to: 'queue' },
      { from: 'queue', to: 'worker' },
      { from: 'jobs', to: 'worker' },
      { from: 'worker', to: 'db' },
      { from: 'db', to: 'cdn' },
      { from: 'api', to: 'stray' },
    ],
  }
  const l = layout(grouped as never)
  type R = { x: number; y: number; w: number; h: number }
  const within = (b: R, g: R) => b.x >= g.x && b.x + b.w <= g.x + g.w && b.y >= g.y && b.y + b.h <= g.y + g.h
  const meets = (a: R, b: R) => a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y
  for (const b of l.boxes) {
    const box = { ...b, h: BOX_H }
    const own = l.groups.filter(g => g.name === b.node.group)
    if (b.node.group) expect(own.some(g => within(box, g))).toBe(true)
    for (const g of l.groups) if (g.name !== b.node.group) expect(meets(box, g)).toBe(false)
  }
  for (const g of l.groups) for (const h of l.groups) if (g !== h) expect(meets(g, h)).toBe(false)
  // edge has web at the top and cdn at the bottom, with ranks between: two borders.
  expect(l.groups.filter(g => g.name === 'edge').length).toBe(2)
  for (const name of ['edge', 'core', 'infra']) expect(l.rows.join('\n')).toContain(` ${name} `)
})

test('review says a small diagram fits, and names the fix when one is too wide, skips levels or has lonely groups', () => {
  expect(review(diagram as never)).toMatch(/fits the pane/)
  const wide = {
    nodes: [
      { id: 'top' },
      ...Array.from({ length: 8 }, (_, i) => ({ id: `mid${i}`, label: `middle service ${i}`, group: i === 0 ? 'solo' : undefined })),
      { id: 'a' },
      { id: 'b' },
      { id: 'c' },
    ],
    edges: [
      ...Array.from({ length: 8 }, (_, i) => ({ from: 'top', to: `mid${i}` })),
      { from: 'mid1', to: 'a' },
      { from: 'a', to: 'b' },
      { from: 'b', to: 'c' },
      { from: 'top', to: 'c' },
      { from: 'top', to: 'b' },
      { from: 'mid2', to: 'c' },
    ],
  }
  const said = review(wide as never)
  expect(said).toMatch(/columns wide, past the ~100 a pane shows \(widest level: 8 boxes\)/)
  expect(said).toMatch(/3 edges skip levels/)
  expect(said).toMatch(/group border around a single box \(solo\)/)
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

const parent = {
  nodes: [{ id: 'gate', label: 'Gateway' }, { id: 'api', label: 'Orders API', detail: 'sub/inner' }, { id: 'db' }],
  edges: [{ from: 'gate', to: 'api' }, { from: 'api', to: 'db' }],
}
const inner = { nodes: [{ id: 'handler' }, { id: 'repo' }], edges: [{ from: 'handler', to: 'repo' }] }
const PANE_PROPS = { title: 'Diagram', isFocused: true, bodyColumns: 100, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} } as const

test('a box linking a detail diagram is marked, the tool says when that diagram is not drawn yet', async ($, on) => {
  engine(on)
  const said = await $.tool.call({ tool: TOOL, op: 'set', name: 'sub', diagram: parent })
  expect(String(said.result)).toMatch(/Detail diagrams linked but not drawn yet: sub\/inner\./)
  await $.tool.call({ tool: TOOL, op: 'set', name: 'sub/inner', diagram: inner })
  const again = await $.tool.call({ tool: TOOL, op: 'set', name: 'sub', diagram: parent })
  expect(String(again.result)).not.toMatch(/not drawn yet/)
  expect(layout(parent as never).boxes.find(b => b.node.id === 'api')!.label).toBe('Orders API ▸')
})

test('left-clicking a ▸ box opens its detail diagram, and the breadcrumb leads back', async ($, on) => {
  engine(on)
  await $.tool.call({ tool: TOOL, op: 'set', name: 'sub/inner', diagram: inner })
  await $.tool.call({ tool: TOOL, op: 'set', name: 'sub', diagram: parent })
  const ui = await $.ui.mount({ plugin: 'archpane', surface: 'terminal', component: 'Pane', requestId: 'archpane', props: PANE_PROPS })
  const api = layout(parent as never).boxes.find(b => b.node.id === 'api')!
  const open = async () => JSON.parse(String((await $.tool.call({ tool: TOOL, op: 'get' })).result)).name

  await ui.pointer({ in: 'canvas', type: 'down', x: api.x + 2, y: api.y + 1, button: 'left' })
  await ui.pointer({ in: 'canvas', type: 'up', x: api.x + 2, y: api.y + 1, button: 'left' })
  expect(await open()).toBe('sub/inner')
  expect(await ui.find({ type: 'Button', key: 'crumb:0' })).toBeDefined()
  expect((await shown(ui)).join('\n')).toContain('handler')

  await ui.press({ key: 'crumb:0' })
  expect(await open()).toBe('sub')
  expect(await ui.find({ type: 'Button', key: 'crumb:0' })).toBeUndefined()
})

test('right-clicking a box shows its menu; its items ask about it or copy its id', async ($, on) => {
  engine(on)
  const filled: string[] = []
  const copied: string[] = []
  on('prompt.fill', (_$, e) => {
    filled.push(e.text)
    return { isFilled: true as const, box: { text: e.text, cursor: e.text.length } }
  })
  on('ui.copy', (_$, e) => {
    copied.push(e.text)
    return { isCopied: true as const }
  })
  on('ui.toast', () => ({}))
  await $.tool.call({ tool: TOOL, op: 'set', name: 'sub', diagram: parent })
  const ui = await $.ui.mount({ plugin: 'archpane', surface: 'terminal', component: 'Pane', requestId: 'archpane', props: PANE_PROPS })
  const api = layout(parent as never).boxes.find(b => b.node.id === 'api')!
  const rightClick = async () => {
    await ui.pointer({ in: 'canvas', type: 'down', x: api.x + 2, y: api.y + 1, button: 'right' })
    await ui.pointer({ in: 'canvas', type: 'up', x: api.x + 2, y: api.y + 1, button: 'right' })
  }
  const choose = async (item: string) => {
    const lines = await shown(ui)
    const y = lines.findIndex(l => l.includes(item))
    await ui.pointer({ in: 'canvas', type: 'down', x: lines[y]!.indexOf(item) + 1, y, button: 'left' })
    await ui.pointer({ in: 'canvas', type: 'up', x: lines[y]!.indexOf(item) + 1, y, button: 'left' })
  }

  await rightClick()
  const menu = (await shown(ui)).join('\n')
  for (const item of ['Ask about this', 'Open detail ▸', 'Copy id']) expect(menu).toContain(item)
  await choose('Ask about this')
  expect(filled).toEqual(['[diagram sub: api] '])
  expect((await shown(ui)).join('\n')).not.toContain('Copy id')

  await rightClick()
  await choose('Copy id')
  expect(copied).toEqual(['api'])
})
