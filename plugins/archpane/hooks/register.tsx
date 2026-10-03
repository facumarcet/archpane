import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Current, Diagram, DiagramNode, Status } from '../types'
import { draw, drawnSize, toDrawing, type Drawing } from './draw'
import { applyPatch, check, empty, layout, review, STATUSES, type Patch } from './lib'

const PANE = 'archpane'
const TOOL = 'mcp__archpane__diagram'
const DEFAULT = 'main'
const current = atom({ plugin: 'archpane', key: 'current' } as const, null)
// The diagrams above the open one, outermost first: what the breadcrumb leads back to.
const trail = atom({ plugin: 'archpane', key: 'trail' } as const, [])

const COLOR: Record<Status, string> = { planned: 'gray', building: 'yellow', done: 'green', blocked: 'red' }

const node = {
  type: 'object',
  properties: {
    id: { type: 'string', description: 'Stable id, e.g. "order-worker"' },
    label: { type: 'string', description: 'Shown name; defaults to id' },
    kind: { type: 'string', description: 'e.g. service, worker, db, queue, cache, external' },
    group: { type: 'string', description: 'Layer or boundary it belongs to; members are drawn inside a labeled border' },
    status: { type: 'string', enum: STATUSES },
    note: { type: 'string', description: 'One line shown on hover' },
    detail: { type: 'string', description: 'Name of a diagram showing what happens inside this box (e.g. "checkout/payment"); the box is marked ▸ and clicking it opens that diagram' },
  },
  required: ['id'],
}
const edge = {
  type: 'object',
  properties: { from: { type: 'string' }, to: { type: 'string' }, label: { type: 'string' } },
  required: ['from', 'to'],
}

const DESCRIPTION = `Draws and edits a live architecture/component diagram in the user's side pane. Diagrams persist per repository by name.
Use it whenever you design, explain or build a system's components, and keep it current as work progresses (status: planned → building → done).
ops:
- get: current diagram as JSON. Call before answering questions about the diagram or editing it.
- set: replace the whole diagram (title, nodes, edges).
- patch: incremental edit. nodes upsert by id (fields merge), edges upsert by from→to, removeNodes (drops their edges), removeEdges.
- list: diagram names in this repository. open: switch the pane to a diagram (created empty if new). delete: remove one.
Edges point from caller to callee / producer to consumer. Keep labels short; ids stable. In a patch, a field set to "" is cleared.
A node's detail names a subdiagram of what happens inside it: clicking the box opens it, and a breadcrumb leads back. Draw each detail diagram you link.
The user can click a box (or pick "Ask about this" from its right-click menu) to put [diagram <name>: <id>] in their prompt: that names a component, look it up with get.`

type Input = Patch & { op: string; name?: string; diagram?: Diagram }

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
const toDraw = (d: Diagram) => toDrawing(layout(d), s => (s === undefined ? undefined : COLOR[s as Status]))
const tooBig = (drawing: Drawing, cols: number) => {
  const size = drawnSize(drawing, cols)
  return size.data > DRAW_LIMIT.data || size.tree > DRAW_LIMIT.tree
}
const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`

const answer = (value: unknown) => ({ result: typeof value === 'string' ? value : JSON.stringify(value) })

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'diagram', description: 'Open the architecture diagram pane: /diagram [name]' })
    await $.tool.register({
      name: 'diagram',
      description: DESCRIPTION,
      inputSchema: {
        type: 'object',
        properties: {
          op: { type: 'string', enum: ['get', 'set', 'patch', 'list', 'open', 'delete'] },
          name: { type: 'string', description: `Diagram name; defaults to the open one, else "${DEFAULT}"` },
          title: { type: 'string' },
          diagram: { type: 'object', properties: { title: { type: 'string' }, nodes: { type: 'array', items: node }, edges: { type: 'array', items: edge } } },
          nodes: { type: 'array', items: node },
          removeNodes: { type: 'array', items: { type: 'string' } },
          edges: { type: 'array', items: edge },
          removeEdges: { type: 'array', items: { type: 'object', properties: { from: { type: 'string' }, to: { type: 'string' } } } },
        },
        required: ['op'],
      },
    })
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
    await update($, trail, () => [])
    await update($, current, () => next)
    await $.store.set(await lastKey($), next.name)
    await $.ui.open({ id: PANE, title: `Diagram: ${next.name}` })

    return { text: `Diagram "${next.name}" opened (${plural(next.diagram.nodes.length, 'component')}).` }
  })

  on('tool.call', { tool: TOOL }, async ($, e) => {
    const input = e as unknown as Input
    const open = await read($, current)
    const name = input.name?.trim() || open?.name || DEFAULT
    const base = name === open?.name ? open : await load($, name)

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
          diagram =
            input.op === 'set'
              ? {
                  title: input.diagram?.title ?? input.title,
                  nodes: input.diagram?.nodes ?? input.nodes ?? [],
                  edges: input.diagram?.edges ?? input.edges ?? [],
                }
              : applyPatch(base.diagram, input)
        } catch {
          return { deny: 'diagram not changed: nodes, edges, removeNodes and removeEdges must be arrays of the documented shape' }
        }
        const problem = check(diagram)
        if (problem !== undefined) return { deny: `diagram not changed: ${problem}` }
        const l = layout(diagram)
        if (tooBig(toDraw(diagram), 110)) {
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
    const drawing = toDraw(cur.diagram)
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
    const body =
      e.surface === 'terminal' || e.surface === 'desktop' ? (
        (() => {
          const { Client } = $.ui.resolve(e)
          // Room under a small diagram for a box's right-click menu.
          const regionRows = Math.max(l.height, 10)
          return <Client key="canvas" module="./canvas.tsx" props={{ ...drawing, cols, regionRows, name: cur.name }} width={cols} height={regionRows} />
        })()
      ) : (
        draw({ Box, Text }, drawing, 0, cols)
      )

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
