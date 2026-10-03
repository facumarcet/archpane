# archpane

A live architecture diagram in a side pane of Claude Code. Claude draws it and edits it as you talk, and you keep prompting next to it. The diagram stays in its pane instead of being dumped into the chat.

<!-- screenshot: docs/screenshot.png -->

- **Claude draws real diagrams:** components and the edges between them, laid out top-down, with edges routed at right angles and components grouped inside labeled borders.
- **Edit by talking:** "add a Redis cache in front of the API", "mark the worker as done", "what does the queue feed?"
- **Build status:** each component can be `planned`, `building`, `done` or `blocked`, shown by color. Claude can update statuses as it builds.
- **Hover a box** to see its details (kind, group, note, outgoing edges) in a fixed line above the prompt.
- **Drag sideways** to pan wide diagrams. The mouse wheel scrolls vertically.
- **Click a box** to put a reference to it (`[diagram <name>: <id>]`) in your prompt, then ask about it.
- **Saved across sessions,** per repository and per diagram name.
- **Works in any terminal.** It's drawn with text and box-drawing characters, not images. It also works in the desktop app's Code tab. VS Code and mobile get a static drawing.

## Install

```
/plugin marketplace add facumarcet/archpane
/plugin install archpane@archpane
```

If `/diagram` doesn't show up right away, restart Claude Code.

## Use

```
/diagram              open the pane on the last diagram for this repo (or "main")
/diagram payments     switch to, or create, the diagram named "payments"
```

Then ask Claude, for example "diagram the services in this repo and how they talk to each other". Keep asking for changes or questions about it in the same conversation.

The pane docks beside the chat when the terminal is in fullscreen and at least 110 columns wide. Below that, it shows inline above the prompt.

## How it works

archpane is a Claude Code mod: a plugin made of function hooks.

| Piece | File |
| --- | --- |
| The `diagram` tool Claude calls (`get`, `set`, `patch`, `list`, `open`, `delete`), input checks, saving in the plugin store | `hooks/register.tsx` |
| The diagram model, patching, and a layered (Sugiyama-style) layout: cycles reversed, long edges split into waypoints, crossing-reducing ordering sweeps, orthogonal routing in terminal cells | `hooks/lib.ts` |
| Painting boxes and edges into one character grid, sliced to the visible columns and drawn as rows of text runs | `hooks/draw.tsx` |
| The `Client` region that draws it, pans on drag, and turns a click on a box into a prompt reference | `hooks/canvas.tsx` |
| How Claude should author diagrams for a narrow pane: one question per diagram, 5–10 boxes, one direction of flow, stores in notes, groups only for multi-box stages, and how to split a large system into an overview plus `<topic>/<stage>` detail diagrams | `skills/drawing-pane-diagrams/SKILL.md` |

The diagram itself is plain JSON: nodes `{ id, label, kind, group, status, note }` and edges `{ from, to, label }`. Claude reads it back with `get` before answering questions about it, so the diagram, not the chat history, is the source of truth.

After every `set` or `patch` the tool answers with the laid-out size and, when the diagram won't read well in a pane (wider than ~100 columns, more than two edges skipping levels, a group border around a single box), a warning naming the fix. The skill tells Claude to fix those before replying.

## Limits (for now)

- A group whose members sit on non-consecutive levels is drawn as one border per run of levels, each with the group's name.
- Crossing reduction is heuristic (barycenter sweeps), so dense graphs can still tangle.
- Wide diagrams need panning: there's no zoom or compact mode yet.
- If two sessions edit the same diagram at once, the last write wins.
- Diagrams live in your Claude Code config, not in the repo, so they can't be shared with teammates yet.

## Development

```
git clone git@github.com:facumarcet/archpane.git
claude --plugin-dir ./archpane/plugins/archpane   # hot-reloads on every edit
claude plugin test ./archpane/plugins/archpane
claude plugin validate ./archpane/plugins/archpane
```

When Claude Code loads the plugin, it writes the API's TypeScript types to `plugins/archpane/.claude-plugin/types/`, which is git-ignored. After that, `tsc -p plugins/archpane` type-checks it.

## License

MIT
