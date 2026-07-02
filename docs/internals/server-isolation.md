# Server isolation

The framework holds module-global state that needs bucketing so
parallel test workers don't contend:

| State | Module |
|---|---|
| `<Cache>` render-output store | `framework/src/lib/cache.tsx` |
| Partial registry (variant store + per-route hint LRU) | `framework/src/lib/partial-registry.ts` |
| Session store (frame URLs) | `framework/src/runtime/session.ts` |
| Cell storage (per-scope value buckets; only the default scope persists to disk) | `framework/src/runtime/cell-storage.ts` |
| Scheduled-task dedup keys | `framework/src/runtime/context.ts` |
| App-level producers (e.g. the chat log) | `e2e-testing/src/app/chat/log.ts` |

Each one keys its top-level map by `getScope()`:

```ts
const scopes = new Map<string, ScopeState>()

function bucket(scope: string = getScope()): ScopeState {
  let s = scopes.get(scope)
  if (!s) { s = makeFresh(); scopes.set(scope, s) }
  return s
}
```

## Scope derivation

`framework/src/runtime/context.ts::deriveScope`:

- Production: every request → `"default"`.
- Dev with `x-test-scope: <value>` header → `<value>` (the header
  is honoured only under `import.meta.env.DEV`).

The Playwright fixtures (`e2e-testing/e2e/fixtures.ts`) stamp every
page and API-request context with `x-test-scope: worker-<N>` via
`setExtraHTTPHeaders`, so parallel test runs map to per-worker
buckets; state can't cross-contaminate. `<RemoteFrame>` forwards the
header on its internal fetch, so remote renders land in the host
request's bucket. The `/__test/clear-caches` endpoint wipes the
calling scope's buckets (`?all=1` wipes every scope).

## CMS draft store

`cms/data/draft.json` is on-disk and shared across processes —
per-process scoping doesn't extend to the file system.
`/__test/clear-caches` deletes it only when explicitly asked
(`?cms=1`, or the wholesale `?all=1`). Tests that write to draft
must run serially within one worker, or accept that draft state
leaks across them.
