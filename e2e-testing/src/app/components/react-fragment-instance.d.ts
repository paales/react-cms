/**
 * `@types/react/canary.d.ts` declares `FragmentInstance` as an empty
 * interface — the `observeUsing` / `unobserveUsing` method signatures
 * aren't shipped yet. `when-visible.tsx` uses them via a Fragment ref.
 *
 * Augment just what we use. (The framework ships an identical
 * augmentation in `framework/src/lib/react-canary-augment.d.ts`, but
 * each workspace tsconfig only includes its own `src`, so this app
 * needs its own copy.) Delete when DefinitelyTyped fleshes out the
 * interface.
 */

import "react/canary"

declare module "react" {
  interface FragmentInstance {
    observeUsing(observer: IntersectionObserver | ResizeObserver): void
    unobserveUsing(observer: IntersectionObserver | ResizeObserver): void
  }
}
