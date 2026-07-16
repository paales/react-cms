// Client-side public surface for @parton/framework.
//
// The companion to the server barrel (`@parton/framework`). A
// `"use client"` module imports its hooks, client components, and the
// types they need from HERE (`@parton/framework/client`); the server
// barrel carries the server-authored surface (constructors, cells,
// actions, runtime).
//
// ── Why two barrels ─────────────────────────────────────────────────
// Flight resolves a client reference by its DEFINING module (the
// `"use client"` file the symbol lives in), never by the barrel it is
// re-exported through. Pulling a client hook (`useNavigation`) or a
// `"use server"` action through the SERVER barrel from a `"use client"`
// module mis-resolves that reference and surfaces at runtime as
// `chunk.reason.enqueueModel is not a function`. Routing every client
// symbol through this barrel keeps the reference pointed at its client
// module, so a `"use client"` consumer never deep-imports to dodge the
// error.
//
// This module carries NO `"use client"` directive of its own — it is a
// plain re-export pulled into the client graph by its client consumers;
// each re-exported symbol keeps the identity of its own `"use client"`
// defining module. `Redirect` and `PartialErrorBoundary` are exported
// from BOTH barrels: a server tree places them, a client tree wraps
// with them, and both resolve to the one defining module — a single
// client reference, not a duplicate boundary.

// ── Navigation + activation hooks ───────────────────────────────────
export {
  useActivate,
  useNavigation,
  useScrollRestore,
  type ActivatorFire,
} from "./lib/partial-client.tsx"

// ── Cell mutation hook (client) ─────────────────────────────────────
export {
  useCell,
  type CellInputBindings,
  type CellInputOpts,
  type ClientCell,
} from "./lib/cell-client.tsx"

// ── Error-recovery surface (client) ─────────────────────────────────
// `PartialErrorBoundary` is a client component authors place around a
// flaky subtree; `usePartonStale` reads the staleness marker a
// serve-last-known-good carries. See docs/reference/errors.md.
export {
  PartialErrorBoundary,
  usePartonStale,
  type PartonStale,
} from "./lib/partial-error-boundary.tsx"

// ── Client-side redirect ────────────────────────────────────────────
export { Redirect } from "./runtime/redirect-client.tsx"

// ── Client telemetry statement (lossy channel class) ────────────────
export { reportTelemetry } from "./lib/telemetry.ts"

// ── Shared types a "use client" body reads ──────────────────────────
// Erased at build, so no client-reference concern — but a `"use client"`
// module reaches for the same barrel for its types as for its hooks,
// rather than crossing to the server barrel for a type alone.
export type { RenderArgs, ActivatorProps } from "./lib/partial.tsx"
export type { ResolvedCell, LocalCell, CellPartitionScope } from "./lib/cell.ts"
export type { Navigate, FrameworkNavigation } from "./runtime/navigation-api.ts"
