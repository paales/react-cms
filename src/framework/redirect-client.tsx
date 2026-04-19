"use client";

import { useEffect } from "react";

/**
 * Client-side redirect. Rendered by `Root` when a page threw
 * `redirect(url)`. Calls `navigation.navigate` on mount so the
 * framework's route-intercept machinery runs normally (and commits
 * the destination's payload to the destination URL).
 *
 * For HTML requests we'd rather the browser follow a 302 than
 * wait for hydration — the entry handler checks the framework
 * control channel after `renderHTML` awaits and returns 302 +
 * Location, pre-empting this component from ever running on the
 * client. This component is the fallback for RSC refetches, where
 * a `fetch()` 302 would transparently follow and commit the
 * wrong payload.
 */
export function Redirect({ url }: { url: string }) {
  useEffect(() => {
    navigation.navigate(url);
  }, [url]);
  return null;
}
