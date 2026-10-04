# How archpane works

archpane is a Claude Code mod: a plugin made of function hooks, plus one skill.

| Piece | File |
| --- | --- |
| The `diagram` tool's contract with Claude: its description, input schema, and the check of its top-level input | `plugins/archpane/hooks/tool.ts` |
| What the tool's ops (`get`, `set`, `patch`, `list`, `open`, `delete`) do, saving in the plugin store, the `/diagram` command, the pane and its breadcrumb, and the hover line above the prompt | `plugins/archpane/hooks/register.tsx` |
| The diagram model and a layered (Sugiyama-style) layout: cycles reversed, long edges split into waypoints, crossing-reducing ordering sweeps, orthogonal routing in terminal cells, group borders (one function per phase, `layout()` runs them in order), and the size review Claude reads after each edit | `plugins/archpane/hooks/lib.ts` |
| Painting boxes, edges, groups and the right-click menu into one character grid, sliced to the visible columns and drawn as rows of text runs | `plugins/archpane/hooks/draw.tsx` |
| The `Client` region that draws it, pans on drag, opens a subdiagram or asks about a box on click, and shows the right-click menu | `plugins/archpane/hooks/canvas.tsx` |
| How Claude should author diagrams for a narrow pane, including splitting a large system into an overview plus `<topic>/<stage>` detail diagrams | `plugins/archpane/skills/drawing-pane-diagrams/SKILL.md` |

## Design notes

- **The pane slices its own grid.** Everything is painted into one character grid and cut to the visible columns before drawing, rather than relying on the terminal's clipping, which wraps off-screen content back to the left edge.
- **Hover needs sibling runs.** Each row is a row of sibling `Text` runs, because a `Text` nested in another can't trigger its hover group on the terminal.
- **The canvas never takes the keyboard.** A `Client` with a key listener takes focus on click, so all interaction is pointer-only and the prompt keeps the keyboard.
- **Size limits come from the engine.** It refuses canvas data or a drawn tree past 100,000 serialized characters, so the tool refuses a diagram that would exceed that and tells Claude to split it.
- **Diagrams draw as Claude writes them.** A `turn.step` hook reads the `diagram` call's arguments as they stream, cuts the JSON after the last finished box or edge, and shows that in the pane unsaved. The call saves it when it runs; at turn end, a preview nothing saved gives way to the saved diagram.
- **Hot reloads can hand new canvas code old data.** The canvas tolerates missing fields in its props.

## Development

When Claude Code loads the plugin, it writes the API's TypeScript types to `plugins/archpane/.claude-plugin/types/`, which is git-ignored. After that, `tsc -p plugins/archpane` type-checks it.

CI runs on every pull request. It validates the marketplace and the plugin, runs the tests, and installs the plugin from the marketplace into a temporary config the way a user would.
