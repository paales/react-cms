"use client"

import { Button } from "@parton/copies/components/ui/button"
import { useCell, type ResolvedCell } from "@parton/framework/client"
import * as React from "react"

// The bump button and the slow counter are separate partons that commit
// independently, so "is the slow render still in flight?" can't be read
// off this component's own props (the controls lane echoes the new cell
// value long before the slow lane lands). The counter publishes each
// COMMITTED version into this module store via the beacon below; the
// button subscribes and shows the in-flight banner until the bumped
// version actually reaches the DOM.
let committedVersion = 0
const subscribers = new Set<() => void>()

function publishSlowCommit(version: number): void {
  if (version === committedVersion) return
  committedVersion = version
  for (const notify of subscribers) notify()
}

function subscribeSlowCommit(notify: () => void): () => void {
  subscribers.add(notify)
  return () => {
    subscribers.delete(notify)
  }
}

const readSlowCommit = () => committedVersion
const readSlowCommitServer = () => 0

/** Rendered inside the slow counter's output: publishes the version
 *  that committed to the DOM (not the optimistic client-side value). */
export function SlowCommitBeacon({ version }: { version: number }) {
  React.useEffect(() => publishSlowCommit(version), [version])
  return null
}

/**
 * Bumps the slow counter's cell. The write's partition-scoped
 * invalidation wakes the live connection, which opens a ~2.5s lane for
 * `lanes-demo-slow` — while the clock's one-second lanes keep flowing
 * past it. The e2e spec clicks this and asserts the overlap from the
 * partons' own server-clock stamps.
 */
export function LaneSlowBumpButton({ version: cell }: { version: ResolvedCell<number> }) {
  const version = useCell(cell)
  const committed = React.useSyncExternalStore(
    subscribeSlowCommit,
    readSlowCommit,
    readSlowCommitServer,
  )
  const [target, setTarget] = React.useState(0)
  const pending = target > committed
  return (
    <div className="flex flex-col items-start gap-2">
      <Button
        // `data-hydrated`: React owns the button (onClick live) — e2e
        // clicks via the marker-qualified locator.
        ref={(el) => el?.setAttribute("data-hydrated", "")}
        data-testid="lanes-demo-bump"
        onClick={() => {
          const next = version.value + 1
          setTarget(next)
          version.set(next)
        }}
      >
        Bump the slow counter
      </Button>
      {pending ? (
        <p className="text-sm opacity-70" data-testid="lanes-demo-pending">
          {`server is rendering v${target} (~2.5s) — watch the clock keep ticking`}
        </p>
      ) : null}
    </div>
  )
}
