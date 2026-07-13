# Notes

Active research and forward-looking design. Anything that's shipped
and stable lives in `../reference/` (user-facing) or `../internals/`
(framework internals). Anything superseded or abandoned lives in
`../archive/`. Dated captures are fine here — these are working
notes, not the polished surface.

## Current

| File | What it covers |
|---|---|
| [`IDEAS.md`](./IDEAS.md) | Concrete framework backlog — chapters describing what to build. Open items only; resolved/shipped items are deleted, collapsed to a one-line resolved pointer, or moved to `../archive/` when the design exploration is worth preserving. |
| [`user-ideas.md`](./user-ideas.md) | Wider exploratory directions — "what if we…" / "should we investigate…" items, distinct from `IDEAS.md`'s concrete backlog. |
| [`cells-as-resolvers.md`](./cells-as-resolvers.md) | Residue of the design pass that produced bound cells, `gqlCell` / `fragmentCell`, and partition-scoped invalidation — open items get struck through with a "→ shipped" pointer as they land. |
| [`cell-dimensionality.md`](./cell-dimensionality.md) | Live design doc — axes beyond one-value-per-partition (inheritance walks inside one cell's storage: locale, currency, time). Decision open; not currently shipping. |
| [`replicated-state.md`](./replicated-state.md) | Live design doc translating Unreal's actor replication model into parton primitives — the authority taxonomy (server-only / cell / optimistic-shape / client-only) and the genuinely open questions around action results and failure modes. |
| [`remote-frame-arc.md`](./remote-frame-arc.md) | The federation arc — the consolidated `<RemoteFrame>` design: ordinary pages as the unit, trust tiers as splice-time payload constraints, the framework vocabulary, the URL/dimensionality grant, cells across the boundary, the bus/consistency contract, increments. Supersedes `remote-frame-design.md` where they conflict. |
| [`remote-frame-design.md`](./remote-frame-design.md) | Detail backlog for `<RemoteFrame>` v2+ — numbered open questions (permissions / config / auth / batching / sessions / hydration). Read [`remote-frame-arc.md`](./remote-frame-arc.md) first; it wins on conflicts. |
| [`research-to-poc.md`](./research-to-poc.md) | The research→PoC bar and its five gating workstreams (write authorization, storage adapter, deploy-and-drain, error recovery, DX floor) with exit criteria and measure-first items. |
| [`view-culling.md`](./view-culling.md) | Read-tracked view culling via `visible()` — the shipped design + framework-level findings at `/magento/browse`, kept here as the substrate for a future framework `<Scroller>`. |
| [`perspectives.md`](./perspectives.md) | Cross-cutting framing notes — the framework explained through Varnish, React.memo, `use cache`, ESI, etc. Each lens highlights a different constraint. |
| [`AA_CHAT_STREAMING.md`](./AA_CHAT_STREAMING.md) | Demo content for the chat overlay (the file the streaming-chat demo reads first). Not a design doc — kept here because the chat producer resolves filenames against `docs/notes/`. |

## Where else to look

- [`../reference/`](../reference/) — framework reference (intro,
  partial, block, cells, frames-navigation, remote-frame, cache,
  cms, prior-art).
- [`../internals/`](../internals/) — framework internals (testing,
  render-pipeline, streaming, cache-internals, cell-internals,
  registry-internals, frame-scope, server-isolation, server-context,
  flight-gotchas).
- [`../../CLAUDE.md`](../../CLAUDE.md) — project structure, tooling,
  dev workflow.
- [`../archive/`](../archive/) — superseded designs, debugging logs,
  removed APIs (including retired ADRs). See `../archive/README.md`
  for the index.
