"use client"

import { useCallback, useEffect, useState } from "react"
import { useNavigation } from "@react-cms/framework/lib/partial-client.tsx"
import { Button } from "@react-cms/copies/components/ui/button"
import { Input } from "@react-cms/copies/components/ui/input"

/**
 * Manual activator: a plain button that calls
 * `useNavigation().reload({selector: "#" + id})`. Demonstrates
 * `defer={true}` — the framework isn't wired to any trigger; the
 * app decides when to activate.
 */
export function ActivateButton({
  partialId,
  label,
  testId,
  disableTransition,
}: {
  partialId: string
  label?: string
  testId?: string
  /**
   * If true, the refetch bypasses React's `startTransition` wrapper —
   * each response commits on arrival rather than being held back
   * waiting for a newer transition.
   */
  disableTransition?: boolean
}) {
  const nav = useNavigation()
  const [isPending, setIsPending] = useState(false)
  const activate = async () => {
    setIsPending(true)
    try {
      await nav.reload({ selector: `#${partialId}`, disableTransition }).finished
    } finally {
      setIsPending(false)
    }
  }
  return (
    <Button
      type="button"
      size="sm"
      variant="outline"
      data-testid={testId ?? `activate-${partialId}`}
      onClick={activate}
      disabled={isPending}
    >
      {isPending ? "…" : (label ?? "Activate")}
    </Button>
  )
}

/**
 * Read / write a localStorage key.
 */
export function StorageKeyEditor({ storageKey, testId }: { storageKey: string; testId?: string }) {
  const [value, setValue] = useState("")
  const [stored, setStored] = useState<string | null>(null)

  useEffect(() => {
    setStored(localStorage.getItem(storageKey))
    const onStorage = (e: StorageEvent) => {
      if (e.key === storageKey) setStored(e.newValue)
    }
    window.addEventListener("storage", onStorage)
    return () => window.removeEventListener("storage", onStorage)
  }, [storageKey])

  const write = useCallback(() => {
    const oldValue = localStorage.getItem(storageKey)
    localStorage.setItem(storageKey, value)
    // Same-tab storage events don't fire natively — dispatch a synthetic one.
    window.dispatchEvent(
      new StorageEvent("storage", {
        key: storageKey,
        oldValue,
        newValue: value,
        storageArea: localStorage,
      }),
    )
    setStored(value)
  }, [storageKey, value])

  const clear = useCallback(() => {
    const oldValue = localStorage.getItem(storageKey)
    localStorage.removeItem(storageKey)
    window.dispatchEvent(
      new StorageEvent("storage", {
        key: storageKey,
        oldValue,
        newValue: null,
        storageArea: localStorage,
      }),
    )
    setStored(null)
  }, [storageKey])

  return (
    <div className="mt-2 flex flex-wrap items-center gap-2">
      <Input
        data-testid={testId ? `${testId}-input` : `${storageKey}-input`}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder={`value for "${storageKey}"`}
        className="h-7 w-48 text-xs"
      />
      <Button
        type="button"
        size="sm"
        variant="outline"
        data-testid={testId ? `${testId}-set` : `${storageKey}-set`}
        onClick={write}
      >
        Set
      </Button>
      <Button
        type="button"
        size="sm"
        variant="outline"
        data-testid={testId ? `${testId}-clear` : `${storageKey}-clear`}
        onClick={clear}
      >
        Clear
      </Button>
      <code className="text-xs text-muted-foreground font-mono">
        current: {stored == null ? "∅" : JSON.stringify(stored)}
      </code>
    </div>
  )
}
