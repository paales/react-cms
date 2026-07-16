"use client"

/**
 * Forms demo client — exercises the two ergonomics of `useCell.input`:
 *
 *   - `mode: 'onChange'` (default): per-keystroke writes through the
 *     cell batcher. Used here for the `notes` textarea — every
 *     keystroke commits, the value persists across the user's
 *     session (the cell is parton-scoped, partition is the parton's
 *     empty vary → one global slot).
 *
 *   - `mode: 'onSubmit'`: the cell's value seeds an internal local
 *     state via `defaultValue`-style semantics; the hook tracks user
 *     edits without writing to the cell. Used here for the cardName /
 *     cardCvc fields — the input owns the draft locally; submit
 *     passes the drafts to `save(...)`, a plain server function that
 *     writes both cells inside `atomic()` — one wake, and a throw
 *     rolls the batch back.
 */

import { useCell, type ResolvedCell } from "@parton/framework/client"
import { useEffect, useState } from "react"

interface SaveArgs {
  cardName?: string
  cardCvc?: string
}

export interface FormsDemoFormProps {
  cardName: ResolvedCell<string>
  cardCvc: ResolvedCell<string>
  notes: ResolvedCell<string>
  saves: ResolvedCell<string>
  failChance: ResolvedCell<number>
  save: (args: SaveArgs) => Promise<void>
}

export function FormsDemoForm({
  cardName,
  cardCvc,
  notes,
  saves,
  failChance,
  save,
}: FormsDemoFormProps) {
  const name = useCell(cardName)
  const cvc = useCell(cardCvc)
  const notesCell = useCell(notes)
  const savesView = useCell(saves)
  const failChanceView = useCell(failChance)

  // onSubmit-mode bindings: uncontrolled `<input>`. defaultValue from
  // cell.value, no per-keystroke state, no hook re-renders. Harvest at
  // submit time via `name.read()` / `cvc.read()` (reads the current
  // DOM value through the bound ref).
  const nameInput = name.input({ mode: "onSubmit" })
  const cvcInput = cvc.input({ mode: "onSubmit" })

  // onChange-mode bindings: every keystroke writes through the cell
  // batcher. `.value` is optimistic-aware (latest local write while
  // pending, else server-authoritative).
  const notesInput = notesCell.input({ mode: "onChange" })

  const [lastResult, setLastResult] = useState<"idle" | "pending" | "ok" | "failed">("idle")
  const [lastError, setLastError] = useState<string>("")

  const inputClass =
    "flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs transition-colors outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50"

  return (
    <div className="space-y-3" data-testid="forms-demo-form">
      <label className="flex items-start gap-2 text-xs leading-snug">
        <input
          type="range"
          min={0}
          max={1}
          step={0.1}
          value={failChanceView.value}
          onChange={(e) => void failChanceView.set(Number(e.target.value))}
          data-testid="forms-fail-chance"
          className="cursor-pointer"
        />
        <span data-testid="forms-fail-chance-label">
          Simulated failure chance: <code>{(failChanceView.value * 100).toFixed(0)}%</code> (server
          throws this often; transaction rolls back, optimistic UI rewinds)
        </span>
      </label>

      <div className="grid gap-3">
        <div className="flex flex-col gap-1">
          <label htmlFor="forms-card-name" className="text-xs">
            Cardholder name{" "}
            <span className="text-muted-foreground">
              (onSubmit mode — local draft, commits via save)
            </span>
          </label>
          <input
            {...nameInput}
            id="forms-card-name"
            data-testid="forms-card-name"
            autoComplete="off"
            spellCheck={false}
            className={inputClass}
          />
        </div>

        <div className="flex flex-col gap-1">
          <label htmlFor="forms-card-cvc" className="text-xs">
            CVC{" "}
            <span className="text-muted-foreground">
              (onSubmit mode — local draft, commits via save)
            </span>
          </label>
          <input
            {...cvcInput}
            id="forms-card-cvc"
            data-testid="forms-card-cvc"
            autoComplete="off"
            spellCheck={false}
            inputMode="numeric"
            className={inputClass}
          />
        </div>

        <div className="flex flex-col gap-1">
          <label htmlFor="forms-notes" className="text-xs">
            Notes{" "}
            <span className="text-muted-foreground">
              (onChange mode — directly bound to the cell, every keystroke writes; persists across
              the session)
            </span>
          </label>
          <textarea
            {...notesInput}
            id="forms-notes"
            data-testid="forms-notes"
            rows={3}
            className={`${inputClass} h-auto resize-y py-2`}
          />
        </div>

        <button
          type="button"
          data-testid="forms-save"
          disabled={lastResult === "pending"}
          onClick={async () => {
            setLastResult("pending")
            setLastError("")
            try {
              await save({ cardName: name.read(), cardCvc: cvc.read() })
              setLastResult("ok")
            } catch (err) {
              setLastResult("failed")
              setLastError(err instanceof Error ? err.message : String(err))
            }
          }}
          className="inline-flex h-9 items-center justify-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground shadow-xs hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {lastResult === "pending" ? "Saving…" : "Save card fields"}
        </button>
      </div>

      <div className="rounded border border-border bg-muted/40 p-2 text-xs">
        <div className="mb-1 font-semibold text-muted-foreground">
          Cell view (optimistic <code>.value</code> vs server <code>.serverValue</code>):
        </div>
        <div className="grid grid-cols-2 gap-2 font-mono">
          <div data-testid="forms-optimistic-name">
            <span className="text-muted-foreground">optimistic name:</span> {name.value || "—"}
          </div>
          <div data-testid="forms-server-name">
            <span className="text-muted-foreground">server name:</span> {name.serverValue || "—"}
          </div>
          <div data-testid="forms-optimistic-cvc">
            <span className="text-muted-foreground">optimistic cvc:</span> {cvc.value || "—"}
          </div>
          <div data-testid="forms-server-cvc">
            <span className="text-muted-foreground">server cvc:</span> {cvc.serverValue || "—"}
          </div>
        </div>
      </div>

      <div className="rounded border border-border bg-muted/40 p-2 text-xs">
        <div className="mb-1 font-semibold text-muted-foreground">
          Live notes (cell-bound, per-keystroke persistence):
        </div>
        <div className="font-mono break-all" data-testid="forms-notes-server">
          {notesCell.serverValue || "—"}
        </div>
      </div>

      <div className="rounded border border-border bg-muted/40 p-2 text-xs">
        <div className="mb-1 font-semibold text-muted-foreground">Last save snapshot (JSON):</div>
        <div className="font-mono break-all" data-testid="forms-saves-json">
          {savesView.value || "—"}
        </div>
        <div className="mt-1" data-testid="forms-last-result">
          <span className="text-muted-foreground">last:</span> {lastResult}
          {lastError ? ` — ${lastError}` : ""}
        </div>
      </div>
    </div>
  )
}
