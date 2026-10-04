import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Current, Diagram, DiagramNode, Status } from '../types'
import { draw, drawnSize, toDrawing, type Drawing } from './draw'
import { applyPatch, check, empty, layout, partialJson, review, STATUSES, type Layout } from './lib'
import { DEFAULT, DESCRIPTION, INPUT_SCHEMA, readInput, TOOL, type Input } from './tool'

const PANE = 'archpane'
const current = atom({ plugin: 'archpane', key: 'current' } as const, null)
// The diagrams above the open one, outermost first: what the breadcrumb leads back to.
const trail = atom({ plugin: 'archpane', key: 'trail' } as const, [])

const COLOR: Record<Status, string> = { planned: 'gray', building: 'yellow', done: 'green', blocked: 'red' }

// ponytail: $.store is one file per user, keyed here by repo root; last write wins across concurrent sessions.
const keyOf = async ($: EngineInterface, name: string) => `diagram:${await $.session.root()}:${name}`
const lastKey = async ($: EngineInterface) => `last:${await $.session.root()}`
const names = async ($: EngineInterface) => {
  const prefix = await keyOf($, '')
  return (await $.store.keys()).filter(k => k.startsWith(prefix)).map(k => k.slice(prefix.length))
}

async function load($: EngineInterface, name: string): Promise<Current> {
  const saved = (await $.store.get(await keyOf($, name))) as Diagram | undefined
  return { name, diagram: saved ?? empty() }
}

/**
 * Puts `cur` in the pane. `above` is the breadcrumb to it: none unless drilling down or back.
 * Only an edit saves the diagram: navigating must not bring a deleted one back.
 */
async function show($: EngineInterface, cur: Current, above: string[] = [], save = true) {
  await update($, trail, () => above)
  await update($, current, () => cur)
  if (save) await $.store.set(await keyOf($, cur.name), cur.diagram)
  await $.store.set(await lastKey($), cur.name)
  void $.ui.open({ id: PANE, title: `Diagram: ${cur.name}` })
}

// The engine refuses canvas data or a drawn tree past 100,000 characters; the estimate
// runs high (measured: ~108k still drew, ~134k didn't), so this only refuses what it would.
const DRAW_LIMIT = { data: 90_000, tree: 100_000 }
// An edit is checked at a wide pane's width: the widest window draws the most.
const WIDE_PANE = 110
const toDraw = (l: Layout) => toDrawing(l, s => s && COLOR[s])
const tooBig = (drawing: Drawing, cols: number) => {
  const size = drawnSize(drawing, cols)
  return size.data > DRAW_LIMIT.data || size.tree > DRAW_LIMIT.tree
}
const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`

const answer = (value: unknown) => ({ result: typeof value === 'string' ? value : JSON.stringify(value) })

// What a set or patch makes of the saved diagram; throws on input of the wrong shape.
const edited = (input: Input, base: Diagram): Diagram =>
  input.op === 'set'
    ? {
        title: input.diagram?.title ?? input.title,
        nodes: input.diagram?.nodes ?? input.nodes ?? [],
        edges: input.diagram?.edges ?? input.edges ?? [],
      }
    : applyPatch(base, input)

/**
 * Draws a set or patch the model is still writing: the boxes and edges it has finished, in
 * the pane and unsaved. `call.shown` is what was drawn last, so only a change redraws.
 */
async function preview($: EngineInterface, call: { json: string; shown: string }) {
  const input = readInput(partialJson(call.json))
  if (typeof input === 'string' || (input.op !== 'set' && input.op !== 'patch')) return
  const name = input.name?.trim() || (await read($, current))?.name || DEFAULT
  let diagram: Diagram
  try {
    diagram = edited(input, (await load($, name)).diagram)
  } catch {
    return
  }
  // An edge can arrive before the box it points at.
  const ids = new Set(diagram.nodes.map(n => n.id))
  diagram = { ...diagram, edges: diagram.edges.filter(ed => ids.has(ed.from) && ids.has(ed.to)) }
  const shown = JSON.stringify(diagram)
  if (shown === call.shown || check(diagram) !== undefined) return
  call.shown = shown
  await show($, { name, diagram }, [], false)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'diagram', description: 'Open the architecture diagram pane: /diagram [name]' })
    await $.tool.register({ name: 'diagram', description: DESCRIPTION, inputSchema: INPUT_SCHEMA })
    if ((await read($, current)) === null) {
      const last = (await $.store.get(await lastKey($))) as string | undefined
      if (last !== undefined) {
        const cur = await load($, last)
        await update($, current, () => cur)
      }
    }

    return next(e)
  })

  on('command.run', { command: 'diagram' }, async ($, e) => {
    const asked = e.args.trim()
    if (asked === 'list') {
      const all = (await names($)).sort()
      return { text: all.length === 0 ? 'No diagrams in this project yet.' : `Diagrams in this project:\n${all.map(n => `  ${n}`).join('\n')}` }
    }
    const cur = await read($, current)
    const next = asked !== '' && asked !== cur?.name ? await load($, asked) : (cur ?? (await load($, DEFAULT)))
    await show($, next, [], false)

    return { text: `Diagram "${next.name}" opened (${plural(next.diagram.nodes.length, 'component')}).` }
  })

  on('tool.call', { tool: TOOL }, async ($, e) => {
    const input = readInput(e)
    if (typeof input === 'string') return { deny: `diagram not changed: ${input}` }
    const open = await read($, current)
    const name = input.name?.trim() || open?.name || DEFAULT
    // From the store, not the pane: the pane may hold this call's unsaved preview.
    const base = await load($, name)

    switch (input.op) {
      case 'get':
        return answer(base)
      case 'list':
        return answer({ open: open?.name ?? null, diagrams: await names($) })
      case 'open':
        await show($, base)
        return answer(`Opened "${name}" (${plural(base.diagram.nodes.length, 'component')}).`)
      case 'delete':
        await $.store.delete(await keyOf($, name))
        await update($, trail, t => t.filter(n => n !== name))
        if (open?.name === name) await update($, current, () => ({ name, diagram: empty() }))
        return answer(`Deleted "${name}".`)
      case 'set':
      case 'patch': {
        let diagram: Diagram
        try {
          diagram = edited(input, base.diagram)
        } catch {
          return { deny: 'diagram not changed: nodes, edges, removeNodes and removeEdges must be arrays of the documented shape' }
        }
        const problem = check(diagram)
        if (problem !== undefined) return { deny: `diagram not changed: ${problem}` }
        const l = layout(diagram)
        if (tooBig(toDraw(l), WIDE_PANE)) {
          return {
            deny: `diagram not changed: it lays out to ${l.width}×${l.height}, too large to draw in the pane. Split it into an overview and detail diagrams linked with "detail" (see the drawing-pane-diagrams skill).`,
          }
        }
        await show($, { name, diagram })
        const linked = [...new Set(diagram.nodes.flatMap(n => (n.detail ? [n.detail] : [])))]
        const drawn = new Set(await names($))
        const missing = linked.filter(l => !drawn.has(l))
        const todo = missing.length > 0 ? ` Detail diagrams linked but not drawn yet: ${missing.join(', ')}.` : ''
        return answer(`"${name}" now has ${plural(diagram.nodes.length, 'component')} and ${plural(diagram.edges.length, 'edge')}. ${review(diagram)}${todo}`)
      }
      default:
        return { deny: `unknown op "${input.op}"` }
    }
  })

  // A diagram call draws while the model writes it, box by box; the call itself saves it.
  on('turn.step', async function* ($, e, next) {
    const calls = new Map<number, { json: string; shown: string }>()
    const stream = next(e)
    for await (const chunk of stream) {
      yield chunk
      if (chunk.kind === 'tool' && chunk.name === TOOL) calls.set(chunk.index, { json: '', shown: '' })
      const call = chunk.kind === 'input' ? calls.get(chunk.index) : undefined
      if (call && chunk.kind === 'input') {
        call.json += chunk.json
        await preview($, call)
      }
    }
    return await stream.result
  })

  // A preview no call saved (interrupted, denied, refused) gives way to what is saved.
  on('turn.complete', async ($, e, next) => {
    const cur = await read($, current)
    if (cur !== null) {
      const saved = await load($, cur.name)
      if (JSON.stringify(saved.diagram) !== JSON.stringify(cur.diagram)) await update($, current, () => saved)
    }
    return next(e)
  })

  // The hover detail lives in the band above the prompt: it stays put while the pane scrolls.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const cur = await read($, current)
    const isOpen = (await $.ui.panes()).some(p => p.id === PANE)
    if (cur === null || cur.diagram.nodes.length === 0 || !isOpen) return next(e)

    const { Box, Text } = $.ui.resolve(e)
    const detail = (n: DiagramNode) => {
      const out = cur.diagram.edges.filter(ed => ed.from === n.id).map(ed => (ed.label ? `${ed.to} (${ed.label})` : ed.to))
      return [n.id, n.kind, n.group && `in ${n.group}`, n.status, n.note, out.length > 0 && `→ ${out.join(', ')}`]
        .filter(Boolean)
        .join(' · ')
    }

    return (
      <Box flexDirection="column">
        <Box height={1} width={e.props.bodyColumns}>
          {cur.diagram.nodes.map(n => (
            <Box
              key={`d:${n.id}`}
              position="absolute"
              top={0}
              left={0}
              display="none"
              hover={{ scope: `n:${n.id}`, display: 'flex' }}
            >
              <Text color="cyan" wrap="truncate">{detail(n)}</Text>
            </Box>
          ))}
        </Box>
        {await next(e)}
      </Box>
    )
  })

  // What the canvas asks for, for a box of the open diagram: data from client code, checked here.
  on('ui.message', { requestId: PANE }, async ($, e) => {
    const data = (e.data ?? {}) as { pick?: unknown; open?: unknown; copy?: unknown }
    const cur = await read($, current)
    const node = cur?.diagram.nodes.find(n => n.id === (data.pick ?? data.open ?? data.copy))
    if (!cur || !node) return {}

    if (data.pick !== undefined) {
      const ref = `[diagram ${cur.name}: ${node.id}]`
      await $.prompt.fill({ text: `${ref} `, mode: 'insert', decorations: [{ start: 0, end: ref.length, color: 'cyan' }] })
    } else if (data.open !== undefined && node.detail) {
      const child = await load($, node.detail)
      const above = [...(await read($, trail)), cur.name]
      // A detail already on the way here (itself, or a cycle) goes back to it, not deeper.
      const seen = above.indexOf(node.detail)
      if (child.diagram.nodes.length === 0) {
        $.ui.toast(`"${node.detail}" isn't drawn yet: ask Claude to draw it`)
      } else {
        await show($, child, seen === -1 ? above : above.slice(0, seen), false)
      }
    } else if (data.copy !== undefined) {
      await $.ui.copy({ text: node.id, surface: e.surface })
      $.ui.toast(`Copied ${node.id}`)
    }

    return {}
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    const cur = await read($, current)
    const above = await read($, trail)
    if (cur === null || cur.diagram.nodes.length === 0) {
      return (
        <Box flexDirection="column">
          <Text bold>{cur?.name ?? DEFAULT}</Text>
          <Text dimColor>Empty. Ask Claude to draw the architecture, e.g. "diagram the services in this repo".</Text>
        </Box>
      )
    }

    const l = layout(cur.diagram)
    const cols = e.props.bodyColumns
    const drawing = toDraw(l)
    if (tooBig(drawing, cols)) {
      return (
        <Box flexDirection="column">
          <Text bold>{cur.diagram.title ?? cur.name}</Text>
          <Text color="yellow">
            {`Too large to draw here (${l.width}×${l.height}). Ask Claude to split it into an overview and detail diagrams.`}
          </Text>
        </Box>
      )
    }
    const isWide = l.width > cols
    // Terminal and desktop pan with the pointer through a Client; the rest draw it still.
    // A small diagram's region keeps room under it for a box's right-click menu.
    const regionRows = Math.max(l.height, 10)
    let body
    if (e.surface === 'terminal' || e.surface === 'desktop') {
      const { Client } = $.ui.resolve(e)
      body = <Client key="canvas" module="./canvas.tsx" props={{ ...drawing, cols, regionRows, name: cur.name }} width={cols} height={regionRows} />
    } else {
      body = draw({ Box, Text }, drawing, 0, cols)
    }

    // Back up the breadcrumb: crumb `i` becomes the open diagram, what was above it stays above.
    const back = async (i: number) => {
      const to = await load($, above[i]!)
      if (to.diagram.nodes.length > 0) return show($, to, above.slice(0, i), false)
      $.ui.toast(`"${above[i]}" no longer exists`)
      await update($, trail, t => t.filter(n => n !== above[i]))
    }

    return (
      <Box flexDirection="column">
        {above.length > 0 && (
          <Box flexDirection="row">
            {above.map((name, i) => (
              <Box flexDirection="row">
                <Button key={`crumb:${i}`} plain label={name} onPress={() => back(i)} />
                <Text dimColor> › </Text>
              </Box>
            ))}
            <Text bold>{cur.name}</Text>
          </Box>
        )}
        <Text bold wrap="truncate">{cur.diagram.title ?? cur.name}</Text>
        <Text wrap="truncate">
          {STATUSES.map(s => (
            <Text color={COLOR[s]}>■ {s}  </Text>
          ))}
          <Text dimColor>{`· click to ask or open ▸ · right-click for more${isWide ? ' · drag to pan' : ''}`}</Text>
        </Text>
        {body}
      </Box>
    )
  })
}
