# Server context

A value threaded parent→child through the server render tree, readable
during a Server Component's render. React's RSC renderer has no Context
for Server Components (and the experimental `createServerContext` was
removed), so the framework implements it as a small patch to the vendored
Flight server.

It exists to carry a parton's `parent` (`PartialCtx` — ancestor id path +
frame chain) without threading a `parent={parent}` prop through every call
site. The shim is `framework/src/lib/server-context.ts`; the patch is
`.yarn/patches/@vitejs-plugin-rsc-*.patch`.

## Why not AsyncLocalStorage

Both ALS strategies fail for this, and we have probes proving it
(`__tests__/als-parent-probe`):

- `als.run(ctx, …)` does not survive `await` — a parton's children render
  in a continuation outside the `run` scope, so they read nothing.
- `als.enterWith(ctx)` leaks across siblings — React's work loop renders
  siblings in one shared async context, so the last `enterWith` wins and
  sibling subtrees cross-contaminate.

The only state that survives `await` *and* isolates siblings is React's
own **Task** state: each task is a node in the render tree, and the Task
graph already threads values parent→child (e.g. `formatContext`).

## The patch (three edits, dev + prod edge builds)

Authored by `scripts/patch-plugin-rsc-server-context.mjs`; each edit
asserts a unique anchor, so an upstream change fails loudly.

1. **`createTask`** gains `partonContext` (and `partonChildContext`),
   inherited from `request.__renderingTask` — the task whose render is
   executing — exactly how `formatContext` is already inherited.
2. **`retryTask`** save/restores `request.__renderingTask` around its
   body, so it always names the currently-rendering task. Without the
   restore, a depth-first sibling render (`retryTask(A)` nested inside the
   parent's processing) clobbers it and the next sibling (`B`) wrongly
   inherits `A`'s child context.
3. The **render site** stamps the rendering task onto
   `ReactSharedInternalsServer.__partonTask`, so a component can reach it.

## The shim + the sync-top rule

`server-context.ts` reads `ReactSharedInternalsServer.__partonTask`:

- `getAmbientParent()` → the rendering task's inherited `partonContext`
  (`ROOT` at the top of a render).
- `captureCurrentTask()` → the task handle.
- `setTaskChildContext(task, ctx)` → scope `ctx` to this task's
  descendants (its child tasks inherit it as their `partonContext`).

**Read `getAmbientParent()` / capture the task synchronously at the top of
a render**, before the first `await`. The `__partonTask` pointer is reused
for the next task that renders, so only the synchronous window is valid.
The captured task *object* is stable, so `setTaskChildContext` may follow
`await`s. A parton's `parent`-read, id derivation, and child-context set
are all synchronous, so they happen before its schema/cell awaits.

Isolated renders that are their own render root — a cache hole, a
`<RemoteFrame>`, an addressable refetch — have no ambient parent task;
those inject `parent` explicitly (the `__parent` prop) and the task graph
threads it onward to descendants from there.

## Maintaining the patch across upgrades

The patch targets `@vitejs/plugin-rsc`'s vendored
`react-server-dom-webpack-server.edge.{development,production}.js`. On an
upgrade, regenerate it:

```
yarn patch @vitejs/plugin-rsc
node scripts/patch-plugin-rsc-server-context.mjs <printed-temp-dir>
yarn patch-commit -s <printed-temp-dir>
```

If an anchor no longer matches, the script throws — re-locate `createTask`
/ `retryTask` / the render site in the new build and update the anchors.
The wire format and these internals are unspecified and may change; the
asserted anchors are the early-warning system.
