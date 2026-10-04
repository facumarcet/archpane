import type { Diagram } from '../types'
import { STATUSES, type Patch } from './lib'

// The `diagram` tool's contract with the model: its name, description and input.
export const TOOL = 'mcp__archpane__diagram'
export const DEFAULT = 'main'

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

export const DESCRIPTION = `Draws and edits a live architecture/component diagram in the user's side pane. Diagrams persist per repository by name.
Use it whenever you design, explain or build a system's components, and keep it current as work progresses (status: planned → building → done).
ops:
- get: current diagram as JSON. Call before answering questions about the diagram or editing it.
- set: replace the whole diagram (title, nodes, edges).
- patch: incremental edit. nodes upsert by id (fields merge), edges upsert by from→to, removeNodes (drops their edges), removeEdges.
- list: diagram names in this repository. open: switch the pane to a diagram (created empty if new). delete: remove one.
Edges point from caller to callee / producer to consumer. Keep labels short; ids stable. In a patch, a field set to "" is cleared.
A node's detail names a subdiagram of what happens inside it: clicking the box opens it, and a breadcrumb leads back. Draw each detail diagram you link.
The user can click a box (or pick "Ask about this" from its right-click menu) to put [diagram <name>: <id>] in their prompt: that names a component, look it up with get.`

export const INPUT_SCHEMA = {
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
}

export type Input = Patch & { op: string; name?: string; diagram?: Diagram }

/**
 * The model's input is untrusted: its top-level fields are checked here, and what a
 * set or patch builds from the rest is checked whole by `check` before it's kept.
 */
export function readInput(e: unknown): Input | string {
  if (typeof e !== 'object' || e === null) return 'input must be an object'
  const input = e as Record<string, unknown>
  if (typeof input.op !== 'string') return 'op must be a string'
  for (const field of ['name', 'title'] as const) {
    if (input[field] !== undefined && typeof input[field] !== 'string') return `${field} must be a string`
  }
  if (input.diagram !== undefined && (typeof input.diagram !== 'object' || input.diagram === null)) return 'diagram must be an object'

  return input as Input
}
