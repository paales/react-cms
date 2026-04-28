/**
 * Discovery renderer: walks a React element tree and executes all components
 * to trigger proxy access recording, without producing any renderable output.
 *
 * Usage:
 *   renderForDiscovery(<PokemonListPage pokemonList={phantom} />)
 *
 * This recursively calls every component in the tree, which causes
 * proxy property accesses to be recorded by the AccessRecorder.
 * The rendered output is discarded.
 */

import { type ReactElement, type ReactNode, isValidElement, Children } from "react"

export function renderForDiscovery(element: ReactNode): void {
  if (element == null || typeof element === "boolean") return
  if (typeof element === "string" || typeof element === "number") return

  // Arrays (e.g., from .map())
  if (Array.isArray(element)) {
    for (const child of element) {
      renderForDiscovery(child)
    }
    return
  }

  if (!isValidElement(element)) return

  const el = element as ReactElement<any>
  const { type, props } = el

  if (typeof type === "function") {
    // Function component — call it to trigger proxy accesses
    try {
      const result = (type as (props: any) => ReactNode)(props)
      renderForDiscovery(result)
    } catch {
      // Component threw (e.g., client component with hooks) —
      // still walk children so nested server components get discovered
      if (props?.children != null) {
        Children.forEach(props.children, (child) => {
          renderForDiscovery(child)
        })
      }
    }
    return
  }

  // Host element (div, span, etc.) — walk children
  if (props?.children != null) {
    Children.forEach(props.children, (child) => {
      renderForDiscovery(child)
    })
  }
}
