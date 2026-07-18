"use client"

import { useCell, useNavigation, type ResolvedCell } from "@parton/framework/client"

export function Reload(props: { children: React.ReactNode }) {
  const [reload, progress] = useNavigation().reload()
  return <button {...props} onClick={() => reload({ streaming: true })} />
}

export function CellCheckbox({
  cell,
}: { cell: ResolvedCell<boolean> } & Omit<React.ComponentProps<"input">, "">) {
  const bool = useCell(cell)

  return <input type="checkbox" checked={bool.value} onChange={() => bool.set(!bool.value)} />
}
