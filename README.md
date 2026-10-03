# archpane

A live architecture diagram in a side pane of Claude Code. Claude draws it and edits it as you talk, and you keep prompting next to it. The diagram stays in its pane instead of being dumped into the chat.

<!-- screenshot: docs/screenshot.png -->

- **Claude draws real diagrams:** components and the edges between them, laid out top-down, with edges routed at right angles.
- **Edit by talking:** "add a Redis cache in front of the API", "mark the worker as done", "what does the queue feed?"
- **Build status:** each component can be `planned`, `building`, `done` or `blocked`, shown by color. Claude can update statuses as it builds.
- **Hover a box** to see its details (kind, group, note, outgoing edges) in a fixed line above the prompt.
- **Drag sideways** to pan wide diagrams. The mouse wheel scrolls vertically. After clicking into the diagram, `h`/`l` or `←`/`→` pan too.
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
| The diagram model, patching, and the layout (ranks, ordering, orthogonal edge routing in terminal cells) | `hooks/lib.ts` |
| Drawing a laid-out diagram as boxes and edge rows in the normal flow | `hooks/draw.tsx` |
| The `Client` region that draws it and turns pointer drags and keys into panning | `hooks/canvas.tsx` |

The diagram itself is plain JSON: nodes `{ id, label, kind, group, status, note }` and edges `{ from, to, label }`. Claude reads it back with `get` before answering questions about it, so the diagram, not the chat history, is the source of truth.

## Limits (for now)

- `group` only shows on hover. No boxes are drawn around groups yet.
- Ordering within a rank uses a single pass, with no crossing minimization.
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
