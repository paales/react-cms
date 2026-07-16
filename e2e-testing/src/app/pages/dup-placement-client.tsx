"use client"

// Duplicate-placement fixture — see dup-placement.tsx. The reload
// button is a bare useNavigation().reload() (a full document reload,
// the post-reload attach catch-up path the spec drives).

import { useNavigation } from "@parton/framework/client"

export function DupReload() {
  const [reload] = useNavigation().reload()
  return (
    <button data-testid="dup-reload" onClick={() => reload()}>
      reload
    </button>
  )
}
