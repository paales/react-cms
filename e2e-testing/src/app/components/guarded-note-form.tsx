"use client"

/**
 * Guarded-note client controls. The save button calls the resolved
 * cell's `.set` directly — the raw `__cellWrite` action POST, the
 * exact surface the `writeGuard` exists to protect. A denial rejects
 * the promise; this component catches it and renders its own denied
 * state (production redacts server error messages, so the UI text is
 * the author's, not the server's). The bump button writes the
 * UNGUARDED control cell — after a denial it must still commit,
 * proving the page isn't wedged.
 */

import type { ResolvedCell } from "@parton/framework/client"
import { useState } from "react"

export interface GuardedNoteFormProps {
  note: ResolvedCell<string>
  bumps: ResolvedCell<number>
  claim: () => Promise<void>
  release: () => Promise<void>
}

// `data-hydrated`: React owns the control (handler live) — specs
// interact through the qualified locator so a click never lands on
// inert SSR DOM.
const hydrated = (el: HTMLElement | null): void => el?.setAttribute("data-hydrated", "")

export function GuardedNoteForm({ note, bumps, claim, release }: GuardedNoteFormProps) {
  const [draft, setDraft] = useState("")
  const [status, setStatus] = useState<"idle" | "pending" | "saved" | "denied">("idle")

  const onSave = async (): Promise<void> => {
    setStatus("pending")
    try {
      await note.set(draft)
      setStatus("saved")
    } catch {
      setStatus("denied")
    }
  }

  const inputClass =
    "flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs outline-none focus-visible:border-ring"

  return (
    <div className="space-y-3" data-testid="guarded-note-form">
      <div className="flex gap-2">
        <input
          ref={hydrated}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="new note text"
          data-testid="guarded-note-input"
          className={inputClass}
        />
        <button
          ref={hydrated}
          onClick={() => void onSave()}
          data-testid="guarded-note-save"
          className="rounded-md border px-3 py-1 text-sm cursor-pointer"
        >
          Save note
        </button>
      </div>
      <div data-testid="guarded-note-status" className="text-sm">
        {status === "idle" && "no write attempted yet"}
        {status === "pending" && "saving…"}
        {status === "saved" && "saved"}
        {status === "denied" && "denied — the server rejected this write"}
      </div>
      <div className="flex gap-2">
        <button
          ref={hydrated}
          onClick={() => void claim()}
          data-testid="guarded-note-claim"
          className="rounded-md border px-3 py-1 text-sm cursor-pointer"
        >
          Claim ownership
        </button>
        <button
          ref={hydrated}
          onClick={() => void release()}
          data-testid="guarded-note-release"
          className="rounded-md border px-3 py-1 text-sm cursor-pointer"
        >
          Release ownership
        </button>
        <button
          ref={hydrated}
          onClick={() => void bumps.set(bumps.value + 1)}
          data-testid="guarded-note-bump"
          className="rounded-md border px-3 py-1 text-sm cursor-pointer"
        >
          Bump (unguarded)
        </button>
      </div>
    </div>
  )
}
