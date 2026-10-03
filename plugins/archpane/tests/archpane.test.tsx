import type { On } from 'claude-code'
import { expect, test } from 'claude-code/testing'

import { layout } from '../hooks/lib'

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

test('layout ranks top-down, keeps boxes apart and routes skip/back edges in a channel', () => {
  const l = layout(diagram as never)
  const y = (id: string) => l.boxes.find(b => b.node.id === id)!.y
  expect(y('api') < y('queue') && y('queue') < y('worker') && y('worker') < y('db')).toBe(true)
  for (const a of l.boxes) for (const b of l.boxes) {
    if (a !== b) expect(a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + 4 <= b.y || b.y + 4 <= a.y).toBe(true)
  }
  const mainW = Math.max(...l.boxes.map(b => b.x + b.w))
  expect(l.width > mainW).toBe(true)
  expect(l.rows.join('\n').split('▼').length - 1).toBe(4)
})

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
    expect(await ui.find({ key: 'n:api', in: 'canvas' })).toBeDefined()
  })
}

test('dragging the diagram pans it sideways and stops at its edge', async ($, on) => {
  engine(on)
  await $.tool.call({ tool: TOOL, op: 'set', name: 'pan', diagram })
  const width = layout(diagram as never).width
  const ui = await $.ui.mount({
    plugin: 'archpane',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'archpane',
    props: { title: 'Diagram', isFocused: true, bodyColumns: 10, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
  })
  const pan = async () => {
    const root = (await ui.drawn({ in: 'canvas' })) as unknown as { children: { props: { marginLeft: number } }[] }
    return Math.abs(root.children[0]!.props.marginLeft)
  }
  expect(await pan()).toBe(0)
  await ui.pointer({ in: 'canvas', type: 'down', x: 8, y: 0, button: 'left' })
  await ui.pointer({ in: 'canvas', type: 'move', x: 3, y: 0, button: 'left' })
  expect(await pan()).toBe(5)
  await ui.pointer({ in: 'canvas', type: 'move', x: -200, y: 0, button: 'left' })
  await ui.pointer({ in: 'canvas', type: 'up', x: -200, y: 0, button: 'left' })
  expect(await pan()).toBe(width - 10)
  await ui.key({ in: 'canvas', key: 'h' })
  expect(await pan()).toBe(width - 18)
})
