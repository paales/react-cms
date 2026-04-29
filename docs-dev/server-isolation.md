# Server isolation

The framework holds five module-global maps that need bucketing so
parallel test workers don't contend on the same state:

| State | Module |
|---|---|
| `<Cache>` render-output store | `src/lib/cache.tsx` |
| Partial registry (variant store + per-route hint LRU) | `src/lib/partial-registry.ts` |
| GraphQL response cache | `src/lib/partial-cache.ts` |
| Session store (frame URLs) | `src/framework/session.ts` |
| Chat log producer | `src/app/chat/log.ts` |

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

`src/framework/context.ts::deriveScope`:

- Production: every request → `"default"`.
- Dev with `x-test-scope: <value>` header → `<value>`.

Playwright workers > 1 stamp per-worker scope tokens in their
`page.route` setup. Parallel test runs map to per-worker buckets;
state can't cross-contaminate.

## CMS draft store

`src/cms/draft.json` is on-disk and shared across processes.
`/__test/clear-caches` always deletes it (regardless of `?all=1`)
because per-process scoping doesn't extend to the file system.
Tests that write to draft must run serially within one worker, or
accept that draft state leaks across them.
