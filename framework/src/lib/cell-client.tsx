"use client"

/**
 * Client-side cell API: a microtask-batched coalescer + the `useCell`
 * hook that converts a server-constructed `ResolvedCell` into a
 * client-side object with an **optimistic-aware `value`** and a
 * **batched `set`**.
 *
 * Why a hook and not direct mutation of the resolved cell:
 *
 *   `ResolvedCell` is built server-side in `buildResolvedCell` and
 *   crosses Flight into client components. Its `set` field is the
 *   cell's bound server-action ref (`__cellWrite.bind(null, id)`) —
 *   Flight serialises that natively. A bound **client** function ref
 *   in the same slot is NOT serialisable: Flight rejects it with
 *   `"Functions cannot be passed directly to Client Components"`.
 *   The Render function is a server component, so we can't reshape
 *   `set` there either. The conversion to a client-side cell with a
 *   batched setter has to happen inside a client component — and the
 *   one place a client component can run logic per cell is a hook.
 *
 *   `useCell(serverCell): ClientCell` is that conversion.
 *
 * `value` returned by `useCell` is the **latest local-set value while
 * writes are queued or in flight**, falling back to the server-
 * authoritative value when everything has settled. So binding a
 * controlled input to `cell.value` works directly:
 *
 *     const name = useCell(props.cardName)
 *     <input value={name.value} onChange={(e) => name.set(e.target.value)} />
 *
 * No local `useState`, no `useEffect`-based adoption. The framework
 * holds the optimistic value internally and clears it when the last
 * pending write for the cell drains; the next render uses the
 * server-authoritative value automatically (which is the reconcile
 * moment when the server normalised differently from the client's
 * sent value).
 *
 * `serverValue` is always the server-authoritative snapshot (same as
 * `props.cardName.value`) — exposed for cases that explicitly need the
 * non-optimistic view side-by-side with `value`.
 *
 * Batching + ordering: every `.set(v)` enqueues; a microtask flushes
 * the queue as one `__cellWriteBatch` POST. At most one POST in flight
 * at a time — subsequent enqueues during in-flight accumulate and
 * flush as the next batch when the current resolves. Writes always
 * hit the server in strict send-order. Sequential by design; hybrid
 * logical clocks for parallel writes are future work.
 */

import { useCallback, useLayoutEffect, useRef, useSyncExternalStore, type ChangeEvent } from "react"
import { __cellWriteBatch } from "../runtime/cell-actions.ts"
import { _awaitActionConsequences } from "./channel-registry.ts"
import type { ResolvedCell } from "./cell.ts"

interface QueuedWrite {
  id: string
  value: unknown
  partition: { partition?: Record<string, unknown> } | undefined
  resolve: () => void
  reject: (err: unknown) => void
}

let queue: QueuedWrite[] = []
let flushScheduled = false
let inflight = false

/** Latest value sent for each cell — i.e. the optimistic view. Set by
 *  `enqueue`, cleared when the last pending write for the cell drains.
 *  `useCell` reads this to surface optimistic `value`. */
const latestSentByCell = new Map<string, unknown>()
/** Per-cell-id pending count: queued + in-flight writes for the cell. */
const pendingByCell = new Map<string, number>()
/** Per-cell-id monotonic version. Bumped whenever `latestSentByCell`
 *  changes for the id (set, cleared) — so `useCell` subscribers
 *  re-render at the right moments. Keyed by id so an unrelated cell's
 *  activity doesn't trigger spurious renders. */
const cellVersion = new Map<string, number>()
const subscribers = new Set<() => void>()

function notifySubscribers(): void {
  for (const cb of subscribers) cb()
}

function bumpVersion(id: string): void {
  cellVersion.set(id, (cellVersion.get(id) ?? 0) + 1)
  notifySubscribers()
}

function incrementPending(id: string, value: unknown): void {
  pendingByCell.set(id, (pendingByCell.get(id) ?? 0) + 1)
  latestSentByCell.set(id, value)
  bumpVersion(id)
}

function decrementPending(id: string): void {
  const c = pendingByCell.get(id) ?? 0
  if (c <= 1) {
    pendingByCell.delete(id)
    latestSentByCell.delete(id)
    bumpVersion(id)
  } else {
    pendingByCell.set(id, c - 1)
  }
}

function subscribe(cb: () => void): () => void {
  subscribers.add(cb)
  return () => {
    subscribers.delete(cb)
  }
}

/**
 * Client-side cell view returned by `useCell`.
 *
 * - `value` — optimistic-aware. Latest local-set value while writes
 *   are queued or in flight; falls back to the server-authoritative
 *   value when everything has settled.
 * - `serverValue` — always the server snapshot, for cases that need
 *   the non-optimistic view side-by-side with `value`.
 * - `set(value, opts?)` — enqueues into the microtask-coalesced
 *   batcher; returns a promise that resolves when the batch it
 *   landed in commits.
 * - `input(opts?)` — spread onto a controlled `<input>`. Handles
 *   value binding, onChange → transform → set, and caret restoration
 *   via an internal ref + `useLayoutEffect`. The component never
 *   has to manage local state, refs, layout effects, or pending
 *   checks for input-driven cells.
 *
 * TODO(research): the `input()` shape parallels react-hook-form's
 * `register()` (https://react-hook-form.com/docs/useform/register) —
 * both return `{value/defaultValue, onChange, ref, …}` for spread
 * onto an `<input>`, both absorb the per-input glue (refs, change
 * handlers, validation/transform pipeline). RHF additionally covers
 * `onBlur`, validation rules, controlled/uncontrolled distinctions,
 * field arrays, and submit lifecycle. Worth comparing API surfaces
 * before extending `CellInputOpts` ad-hoc — a closer alignment would
 * make cells drop into RHF-style form patterns without translation.
 */
export interface ClientCell<T> {
  readonly value: T
  readonly serverValue: T
  readonly set: (value: T, opts?: { partition?: Record<string, unknown> }) => Promise<void>
  readonly input: (opts?: CellInputOpts) => CellInputBindings
  /** Read the current input value via the bound ref. Returns the DOM
   *  `<input>`'s `value` when the bindings are attached, falling back
   *  to the optimistic-aware `.value` when no input is mounted. Use
   *  at submit time to harvest an uncontrolled (`mode: 'onSubmit'`)
   *  input without round-tripping through component state. */
  readonly read: () => string
}

/** Options for `ClientCell.input()`. */
export interface CellInputOpts {
  /** Write mode for the returned bindings.
   *
   *  - `'onChange'` (default): every keystroke calls `cell.set` through
   *    the microtask-coalesced batcher. Suited to live state the
   *    framework should persist immediately (drafts, autosave-on-type,
   *    cross-tab broadcast).
   *  - `'onSubmit'`: the input is **uncontrolled by the cell**. The
   *    cell's current value seeds the input as `defaultValue`; local
   *    user edits track in a hook-internal `useState`, and the cell is
   *    NOT written on every keystroke. Read `.value` on the returned
   *    bindings at submit time and pass it through your action (which
   *    will commit via the auto-write semantic). Use this for form
   *    fields where the commit happens through an explicit save. */
  mode?: "onChange" | "onSubmit"
  /** Per-keystroke transform applied to the raw `event.target.value`.
   *  Returns the value to display (= what we send to `cell.set`) and
   *  the caret position to restore after React commits. Without this,
   *  the input is uncontrolled-by-author — value flows straight from
   *  keystrokes to `cell.set` with no client-side cleanup, and the
   *  server's `write` is the only place the value is canonicalised.
   *  Applies in `'onChange'` mode only. */
  transform?: (raw: string, caret: number) => { value: string; caret: number }
  /** Fired after the local transform and after `cell.set` has been
   *  enqueued. Use for cross-cell triggers (e.g. firing a derived
   *  cell's `set` whenever this input changes — see the card-form
   *  demo's CVC stagger). Applies in `'onChange'` mode only. */
  onCommit?: (value: string) => void
}

/** Shape returned by `ClientCell.input()` — spread onto an `<input>` or
 *  `<textarea>`. The `value` / `onChange` pair is populated in
 *  `'onChange'` mode (controlled); the `defaultValue` field is
 *  populated in `'onSubmit'` mode (uncontrolled — the input owns its
 *  own DOM state, the hook does NOT re-render on every keystroke,
 *  and the current value is harvested via `cell.read()` at submit
 *  time). React picks up whichever fields the spread provides; the
 *  unused side is just absent.
 *
 *  `ref` is a callback ref typed contravariantly so the same bindings
 *  work for both `<input>` and `<textarea>` without a generic call
 *  signature — a function accepting `InputishElement | null` is
 *  assignable to React's per-element `RefCallback<HTMLInputElement>`
 *  / `RefCallback<HTMLTextAreaElement>`. */
type InputishElement = HTMLInputElement | HTMLTextAreaElement
export interface CellInputBindings {
  ref: (el: InputishElement | null) => void
  value?: string
  defaultValue?: string
  onChange?: (e: ChangeEvent<InputishElement>) => void
}

export function useCell<T>(cell: ResolvedCell<T>): ClientCell<T> {
  const id = cell.id
  // Subscribe to per-cell-id version. The component re-renders when
  // the latest-sent value for THIS cell flips (added, removed). Other
  // cells' activity doesn't trigger a render here.
  useSyncExternalStore(
    subscribe,
    useCallback(() => cellVersion.get(id) ?? 0, [id]),
    () => 0,
  )
  const hasPending = latestSentByCell.has(id)
  const value = (hasPending ? latestSentByCell.get(id) : cell.value) as T
  const partition = cell.partition
  const set = useCallback(
    (v: T, opts?: { partition?: Record<string, unknown> }) => {
      // Scoped cells carry their partition on the wire (bound at parton
      // resolution time). Default the batcher's per-entry `partition`
      // field to that partition so writes land on the right slot
      // without the caller having to thread it through. Caller-supplied
      // `opts.partition` overrides — useful for the rare cross-partition
      // write from a controlled input bound to a scoped cell.
      const effectiveOpts = opts ?? (partition ? { partition } : undefined)
      return enqueue(id, v, effectiveOpts)
    },
    [id, partition],
  )

  // ── Input bindings: ref + caret-restore plumbing the input() method
  // hands back as part of `{...cell.input()}`. The author never sees
  // any of this; it's the per-cell hook's job.
  //
  // `inputRef` holds the bound element after React attaches it via
  // the callback `ref` returned in bindings. Owned by the hook so
  // `read()` can harvest the current value at submit time without
  // the consumer needing to manage a separate ref.
  const inputRef = useRef<InputishElement | null>(null)
  const pendingCaret = useRef<number | null>(null)
  useLayoutEffect(() => {
    if (pendingCaret.current == null || !inputRef.current) return
    const c = pendingCaret.current
    pendingCaret.current = null
    inputRef.current.setSelectionRange(c, c)
  }, [value])

  // Stable callback ref. Spread into either `<input>` or `<textarea>`
  // — React's per-element ref types accept a callback that takes the
  // wider InputishElement union (contravariance).
  //
  // `data-hydrated` is the element's own "React owns me" marker: the
  // callback ref fires at the commit that attaches (or hydration-
  // adopts) the element, which is also when its `onChange` pipeline
  // goes live. Out-of-process observers (e2e specs) wait on it before
  // typing — input events fired earlier hit inert SSR DOM and are
  // silently lost (React's event replay covers discrete events like
  // click, not text input).
  const refCallback = useCallback((el: InputishElement | null): void => {
    inputRef.current = el
    el?.setAttribute("data-hydrated", "")
  }, [])

  // The `input` closure captures `set` and the refs. It needs the
  // current `value` for its returned `value` field, but the onChange
  // and ref handles are stable.
  const onChangeOnChange = useCallback(
    (
      e: ChangeEvent<InputishElement>,
      transform: CellInputOpts["transform"],
      onCommit: CellInputOpts["onCommit"],
    ) => {
      const raw = e.target.value
      const caret = e.target.selectionStart ?? raw.length
      const t = transform ? transform(raw, caret) : { value: raw, caret }
      pendingCaret.current = t.caret
      void set(t.value as unknown as T)
      onCommit?.(t.value)
    },
    [set],
  )

  const input = useCallback(
    (opts?: CellInputOpts): CellInputBindings => {
      if (opts?.mode === "onSubmit") {
        // Uncontrolled: the input owns its DOM state; the hook does
        // NOT re-render on every keystroke. Value is harvested via
        // `read()` at submit time.
        return {
          defaultValue: cell.value as unknown as string,
          ref: refCallback,
        }
      }
      return {
        value: value as unknown as string,
        ref: refCallback,
        onChange: (e) => onChangeOnChange(e, opts?.transform, opts?.onCommit),
      }
    },
    [value, cell.value, refCallback, onChangeOnChange],
  )

  const read = useCallback((): string => {
    if (inputRef.current) return inputRef.current.value
    return (cell.value as unknown as string) ?? ""
  }, [cell.value])

  return { value, serverValue: cell.value, set, input, read }
}

/**
 * The `set` an embedded `ResolvedCell` carries — a CLIENT reference,
 * not a bound server-action ref.
 *
 * A cell resolved inside a `<RemoteFrame>` embed crosses the splice: the
 * host decodes the producer's payload and re-encodes it into its OWN
 * document render. A bound server reference (`__cellWrite.bind(null,
 * id)`) cannot survive that re-encode — React stalls the host stream on
 * it. A client reference re-encodes as an ordinary same-origin
 * client-module ref (the exact path every client component in an
 * ungoverned embed already takes), so the write routing rides across as
 * DATA (the cell id + partition on the `ResolvedCell`) plus this one
 * host-bundle function.
 *
 * Invoked as a method (`resolvedCell.set(value)`), so `this` is the
 * `ResolvedCell` — its `id` and (baked) `partition` name the write. The
 * write flows through the SAME coalescing batcher `useCell` uses (one
 * `__cellWriteBatch` endpoint, the cell's `writeGuard` + invalidation
 * fan-out unchanged), so a denial rejects the returned promise exactly
 * like the direct-ref path outside an embed.
 */
export function embedCellWrite(
  this: { readonly id: string; readonly partition?: Record<string, unknown> },
  value: unknown,
  opts?: { partition?: Record<string, unknown> },
): Promise<void> {
  const partition = opts?.partition ?? this.partition
  return enqueue(this.id, value, partition ? { partition } : undefined)
}

function enqueue(
  cellId: string,
  value: unknown,
  opts: { partition?: Record<string, unknown> } | undefined,
): Promise<void> {
  incrementPending(cellId, value)
  return new Promise<void>((resolve, reject) => {
    queue.push({ id: cellId, value, partition: opts, resolve, reject })
    if (inflight || flushScheduled) return
    flushScheduled = true
    queueMicrotask(flushQueue)
  })
}

/**
 * Drain the queue one batch at a time, serially. While a batch is
 * in flight (`inflight === true`), new enqueues just push into the
 * queue and don't schedule a parallel flush — they're picked up by
 * the while-loop below when the current POST resolves.
 *
 * The result: at most one `__cellWriteBatch` POST in flight at a
 * time. Writes hit the server in strict send-order regardless of
 * how variable the per-batch latency is. Cells can never observe an
 * out-of-order overwrite from this coalescer.
 */
async function flushQueue(): Promise<void> {
  if (inflight) return
  inflight = true
  flushScheduled = false
  try {
    while (queue.length > 0) {
      const batch = queue
      queue = []
      try {
        await __cellWriteBatch(
          batch.map((w) => ({
            id: w.id,
            value: w.value,
            ...(w.partition ? { partition: w.partition } : {}),
          })),
        )
        // The `.set` promise resolves at batch commit (the POST landed),
        // and the queue keeps flowing — but the OPTIMISTIC OVERLAY holds
        // until the write's server-side consequences have committed on
        // the live connection: with a channel attached, the action
        // response carried the delivery seqs its invalidation
        // consequences ride (`x-parton-consequences`), and clearing at
        // the returnValue alone would flash the stale server value for
        // exactly as long as the consequence lane is delayed (window
        // coalescing makes that the WHOLE backpressure window). Without
        // a channel the gate resolves immediately — unchanged behavior.
        // Order-insensitive: `pendingByCell` counts, so gates resolving
        // across batches out of order still clear correctly.
        for (const w of batch) w.resolve()
        void _awaitActionConsequences().then(() => {
          for (const w of batch) decrementPending(w.id)
        })
      } catch (err) {
        for (const w of batch) {
          decrementPending(w.id)
          w.reject(err)
        }
      }
    }
  } finally {
    inflight = false
  }
}
