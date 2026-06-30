"use client"

/**
 * Controlled-form demo for the cell primitive + the framework's
 * client-side auto-batch.
 *
 * `useCell(serverCell)` returns a `ClientCell` with:
 *
 *   value       — optimistic-aware (latest sent while pending, else
 *                 server-authoritative)
 *   serverValue — always server-authoritative
 *   set(v)      — enqueues into the microtask-coalesced batcher
 *   input(opts) — `{value, onChange, ref}` for controlled inputs;
 *                 the framework owns the caret restore + transform
 *                 pipeline. Author just supplies the per-keystroke
 *                 transform (and an optional `onCommit` for cross-
 *                 cell triggers).
 *
 * The framework's coalescer collapses calls landing in the same tick
 * into ONE `__cellWriteBatch` POST. CVC's `set` is coin-flipped per
 * keystroke: 50% joins the name/number batch (one POST, three cells
 * commit together); 50% fires after a 50 ms setTimeout (two POSTs,
 * name/number then CVC). Open the network panel to see the difference.
 */

import { useCell } from "@parton/framework/lib/cell-client.tsx"
import type { ResolvedCell } from "@parton/framework"
import {
  computeCvc,
  extractNumberDigits,
  transformName,
  transformNameWithCaret,
  transformNumberWithCaret,
} from "../pages/streaming-demo-card-shared.ts"

export interface CardFormProps {
  cardName: ResolvedCell<string>
  cardNumber: ResolvedCell<string>
  cardCvc: ResolvedCell<string>
  /** Demo toggle: when off, the server-side per-batch latency
   *  simulator skips the delay branch. Cell so the choice broadcasts
   *  across tabs and survives reloads. */
  serverDelay: ResolvedCell<boolean>
  /** Demo toggle: when off, the client sends raw keystrokes and lets
   *  the server's `write` transform canonicalise. Same broadcast
   *  semantics as `serverDelay`. */
  applyLocalTransform: ResolvedCell<boolean>
}

const CVC_STAGGER_DELAY_MS = 50

export function CardForm({
  cardName,
  cardNumber,
  cardCvc,
  serverDelay,
  applyLocalTransform,
}: CardFormProps) {
  const name = useCell(cardName)
  const number = useCell(cardNumber)
  const cvc = useCell(cardCvc)
  const delay = useCell(serverDelay)
  const localTransformCell = useCell(applyLocalTransform)
  const localTransform = localTransformCell.value

  // Compute + fire the derived CVC. Pure function of the cleaned
  // (name, number) pair so it matches what the server's `write` will
  // store, regardless of the local-transform toggle. The send path
  // alternates by input length so the demo exercises both: the same
  // microtask batch as the input write (one POST, all three cells) or a
  // 50 ms setTimeout (two POSTs).
  const fireCvc = (nextName: string, nextNumber: string): void => {
    const cvcValue = computeCvc(
      transformName(nextName),
      extractNumberDigits(nextNumber),
    )
    // Deterministic alternation (pure — no Math.random in the
    // render-reachable path) between the same-batch and staggered POST
    // paths the defer specs exercise.
    const sameBatch = (nextName.length + nextNumber.length) % 2 === 0
    if (sameBatch) {
      void cvc.set(cvcValue)
    } else {
      setTimeout(() => cvc.set(cvcValue), CVC_STAGGER_DELAY_MS)
    }
  }

  const inputClass =
    "flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs transition-colors outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50"

  return (
    <div className="space-y-3" data-testid="card-form">
      <label className="flex items-start gap-2 text-xs leading-snug">
        <input
          type="checkbox"
          id="card-server-delay"
          checked={delay.value}
          onChange={(e) => void delay.set(e.target.checked)}
          data-testid="card-server-delay"
          className="mt-0.5 size-4 cursor-pointer"
        />
        <span>
          Simulate server-side per-batch latency (trimodal: 0–30 / 100–200 / 400–500 ms). Off:
          batches commit instantly. The toggle itself is a cell, so flipping it broadcasts to
          every open tab.
        </span>
      </label>
      <label className="flex items-start gap-2 text-xs leading-snug">
        <input
          type="checkbox"
          id="card-local-transform"
          checked={localTransform}
          onChange={(e) => void localTransformCell.set(e.target.checked)}
          data-testid="card-local-transform"
          className="mt-0.5 size-4 cursor-pointer"
        />
        <span>
          Apply transforms locally (predict the server). Off: type raw, watch the input adopt the
          server-formatted value once the batch lands.
        </span>
      </label>

      <div className="grid gap-3">
        <div className="flex flex-col gap-1">
          <label htmlFor="card-name-input" className="text-xs">
            Cardholder name{" "}
            <span className="text-muted-foreground">(uppercase, A–Z + space, ≤26)</span>
          </label>
          <input
            {...name.input({
              transform: localTransform ? transformNameWithCaret : undefined,
              onCommit: (v) => fireCvc(v, number.value),
            })}
            id="card-name-input"
            data-testid="card-name-input"
            autoComplete="off"
            spellCheck={false}
            className={inputClass}
          />
        </div>

        <div className="flex flex-col gap-1">
          <label htmlFor="card-number-input" className="text-xs">
            Card number{" "}
            <span className="text-muted-foreground">
              (digits only; server inserts spaces every 4, ≤16 digits)
            </span>
          </label>
          <input
            {...number.input({
              transform: localTransform ? transformNumberWithCaret : undefined,
              onCommit: (v) => fireCvc(name.value, v),
            })}
            id="card-number-input"
            data-testid="card-number-input"
            autoComplete="off"
            spellCheck={false}
            inputMode="numeric"
            className={inputClass}
          />
        </div>

        <div className="flex flex-col gap-1">
          <label htmlFor="card-cvc-display" className="text-xs">
            CVC{" "}
            <span className="text-muted-foreground">
              (client-computed; sometimes batched with name/number, sometimes a beat later)
            </span>
          </label>
          <input
            id="card-cvc-display"
            value={cvc.value}
            readOnly
            data-testid="card-cvc-display"
            className={`${inputClass} font-mono`}
          />
        </div>
      </div>

      <div className="rounded border border-border bg-muted/40 p-2 text-xs">
        <div className="mb-1 font-semibold text-muted-foreground">
          Server-authoritative cell values (per render segment):
        </div>
        <div className="grid grid-cols-3 gap-2 font-mono">
          <div data-testid="card-server-name">
            <span className="text-muted-foreground">name:</span> {name.serverValue || "—"}
          </div>
          <div data-testid="card-server-number">
            <span className="text-muted-foreground">num:</span> {number.serverValue || "—"}
          </div>
          <div data-testid="card-server-cvc">
            <span className="text-muted-foreground">cvc:</span> {cvc.serverValue || "—"}
          </div>
        </div>
      </div>
    </div>
  )
}
