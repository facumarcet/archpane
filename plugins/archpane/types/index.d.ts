export type Status = 'planned' | 'building' | 'done' | 'blocked'

export type DiagramNode = {
  id: string
  label?: string
  kind?: string
  group?: string
  status?: Status
  note?: string
}

export type DiagramEdge = { from: string; to: string; label?: string }

export type Diagram = { title?: string; nodes: DiagramNode[]; edges: DiagramEdge[] }

export type Current = { name: string; diagram: Diagram }

declare module 'claude-code' {
  interface PluginState {
    archpane: { current: Current | null }
  }
}
