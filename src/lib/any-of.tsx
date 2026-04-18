import {
  Children,
  cloneElement,
  Fragment,
  isValidElement,
  type ReactElement,
  type ReactNode,
} from "react";
import type { ActivatorProps } from "./partial-component.tsx";

/**
 * Recursively flatten Fragment elements so activators written as
 * `<><A/><B/></>` are treated as separate entries. `React.Children.toArray`
 * on a single Fragment element returns the Fragment itself, not its
 * children — we unwrap here so authors can use Fragment grouping
 * naturally.
 */
function flattenActivators(node: ReactNode): ReactElement<ActivatorProps>[] {
  const out: ReactElement<ActivatorProps>[] = [];
  for (const item of Children.toArray(node)) {
    if (!isValidElement(item)) continue;
    if (item.type === Fragment) {
      out.push(
        ...flattenActivators(
          (item.props as { children?: ReactNode }).children,
        ),
      );
    } else {
      out.push(item as ReactElement<ActivatorProps>);
    }
  }
  return out;
}

export interface AnyOfProps extends ActivatorProps {
  /**
   * The activators to compose. First one to fire wins (the `once`
   * guard in `useActivate` makes subsequent fires no-ops).
   */
  activators: ReactNode;
}

/**
 * Compose multiple activators for a single `<Partial defer=…>`. The
 * first activator to fire triggers the refetch; the rest are no-ops.
 *
 *   <Partial id="feed" fallback={<Skel/>} defer={
 *     <AnyOf activators={<>
 *       <WhenVisible rootMargin="200px"/>
 *       <WhenStored storageKey="show-feed"/>
 *     </>}/>
 *   }>
 *     <Feed/>
 *   </Partial>
 *
 * Fallback rendering: the first activator receives the Partial's
 * fallback as its `children`; subsequent activators receive `null`.
 * This avoids rendering the fallback DOM N times. Activators that
 * install DOM-level observers (e.g. `<WhenVisible>`) must therefore
 * be placed first. Activators that observe window-level sources
 * (storage, idle, events) don't care where they sit.
 */
export function AnyOf({
  partialId,
  children,
  activators,
}: AnyOfProps): ReactNode {
  if (!partialId) {
    throw new Error(
      "<AnyOf> requires `partialId`. Use it as the `defer` prop of a <Partial>.",
    );
  }
  const arr = flattenActivators(activators);
  return arr.map((el, i) =>
    cloneElement(
      el,
      { partialId, key: el.key ?? i },
      i === 0 ? children : null,
    ),
  );
}
