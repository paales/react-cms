# Notes

Active research and forward-looking design. Anything that's shipped
and stable lives in `../reference/` (user-facing) or `../internals/`
(framework internals). Anything superseded or abandoned lives in
`../archive/`.

## Current

| File | What it covers |
|---|---|
| [`IDEAS.md`](./IDEAS.md) | Forward-looking backlog. Open items only — resolved/shipped items are deleted, or moved to `../archive/` when the design exploration is worth preserving. |
| [`AA_CHAT_STREAMING.md`](./AA_CHAT_STREAMING.md) | Demo content for the chat overlay (the file the streaming-chat demo reads first). Not a design doc — kept here because the chat producer resolves filenames against `docs/notes/`. |

## Where else to look

- [`../reference/`](../reference/) — framework reference (intro,
  partial, block, frames-navigation, cache, cms, prior-art).
- [`../internals/`](../internals/) — framework internals (testing,
  render-pipeline, cache-internals, registry-internals, frame-scope,
  server-isolation, flight-gotchas).
- [`../adr/`](../adr/) — architecture decision records.
- [`../../CLAUDE.md`](../../CLAUDE.md) — project structure, tooling,
  dev workflow.
- [`../archive/`](../archive/) — superseded designs, debugging logs,
  removed APIs. See `../archive/README.md` for the index.
