/**
 * `@types/react/canary.d.ts` declares `FragmentInstance` as an
 * empty interface — the method signatures for the `observeUsing`
 * / `unobserveUsing` / focus / event APIs aren't shipped yet.
 *
 * Augment just what we use. Delete this file when DefinitelyTyped
 * fleshes out the interface.
 */

import "react/canary"

declare module "react" {
  interface FragmentInstance {
    observeUsing(observer: IntersectionObserver | ResizeObserver): void
    unobserveUsing(observer: IntersectionObserver | ResizeObserver): void
  }
}
