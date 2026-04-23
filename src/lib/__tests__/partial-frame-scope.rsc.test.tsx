/**
 * Regression cover for the "sibling frame scope pollutes ambient fp"
 * bug: a `<Partial frame="X">` rendered as a sibling of an earlier
 * `<Partial frame="Y">` used to fold Y's URL into its fingerprint via
 * `ambientFrameKey`, because `setCurrentFrameScope` mutates a
 * per-request singleton cell that nothing resets between siblings.
 *
 * Symptom in the app: the framed `<ChatOverlay>` on `/` (which
 * follows pokemon's `<Partial frame="search">` in render order) would
 * compute a different fp than the same `<ChatOverlay>` on `/magento`
 * (no sibling frame), so a cross-page nav that should have
 * fingerprint-skipped the overlay would instead re-render it — the
 * streamed chat content would briefly empty while the fresh render
 * re-streamed.
 *
 * Fix: skip `ambientFrameKey` when the Partial opens its own frame.
 * Its content runs inside its own scope, so an ambient sibling leak
 * is semantically irrelevant to the cache.
 *
 * The companion test `pollution does not suppress legitimate ambient
 * frame fold` pins the intended use of `ambientFrameKey`: a nested
 * Partial WITHOUT its own `frame=` prop, sitting inside a framed
 * ancestor, still folds the ancestor's frame URL into its fp so a
 * frame-URL change produces a distinct fp.
 */
import { describe, expect, it, beforeEach, vi } from "vitest";

// `cache.tsx` imports `@vitejs/plugin-rsc/rsc` which pulls in virtual:
// module references the Node ESM loader can't resolve. We don't
// exercise cache semantics here — fingerprint is computed before the
// Cache wrapper ever sees the tree — so bypass-mock it the same way
// `partial.test.tsx` does at the node tier.
vi.mock("../cache.tsx", () => ({
  Cache: ({ children }: { children: React.ReactNode }) => children,
  _cacheStats: async () => ({ size: 0, keys: [] }),
  _clearCache: async () => {},
}));

import { renderWithRequest } from "../../test/rsc-server.ts";
import { PartialRoot, Partial } from "../partial.tsx";
import { clearRegistry } from "../partial-registry.ts";

beforeEach(() => {
  clearRegistry();
});

/**
 * Pull a Partial's `partialFingerprint` prop out of the encoded Flight
 * text. The PartialErrorBoundary client component gets serialised with
 * its props as JSON; we find the `{"partialId":"X", ...,
 * "partialFingerprint":"..."}` pair by locating an object that
 * contains both keys.
 */
function extractFingerprint(text: string, partialId: string): string | null {
  // Props can appear in either order — try both.
  const forward = new RegExp(
    `"partialId"\\s*:\\s*"${partialId}"[^{}]*?"partialFingerprint"\\s*:\\s*"([^"]+)"`,
  );
  const reverse = new RegExp(
    `"partialFingerprint"\\s*:\\s*"([^"]+)"[^{}]*?"partialId"\\s*:\\s*"${partialId}"`,
  );
  return text.match(forward)?.[1] ?? text.match(reverse)?.[1] ?? null;
}

async function renderFp(
  url: string,
  node: React.ReactNode,
  partialId: string,
): Promise<string | null> {
  const { stream } = await renderWithRequest(url, node);
  const text = await new Response(stream).text();
  return extractFingerprint(text, partialId);
}

describe("Partial fingerprint — frame scope isolation", () => {
  it("sibling frame does not pollute a later frame's fingerprint", async () => {
    const withSibling = (
      <PartialRoot>
        <Partial selector="#search" frame="search">
          <span>search body</span>
        </Partial>
        <Partial selector="#chat" frame="chat">
          <span>chat body</span>
        </Partial>
      </PartialRoot>
    );
    const withoutSibling = (
      <PartialRoot>
        <Partial selector="#chat" frame="chat">
          <span>chat body</span>
        </Partial>
      </PartialRoot>
    );

    // Same URL in both renders — the only variable is the presence of
    // a sibling `<Partial frame="search">`. Mirrors the real-world
    // flow (chat-overlay has a session URL, so `ownFrameKey` picks
    // the session URL not the page URL; both renders agree on it).
    // Here we just use the same page URL to take session out of the
    // picture and pin "sibling frame" as the only axis of change.
    const url = "http://localhost/";
    const fpWith = await renderFp(url, withSibling, "chat");
    clearRegistry();
    const fpWithout = await renderFp(url, withoutSibling, "chat");

    expect(fpWith).toBeTruthy();
    expect(fpWithout).toBeTruthy();
    expect(fpWith).toBe(fpWithout);
  });

  it("legitimate ambient fold still works for a nested Partial inside a frame", async () => {
    // A plain (non-framed) `<Partial>` inside a `<Partial frame="outer">`
    // ancestor must fold the enclosing frame URL into its fp, so a
    // frame-URL change invalidates the nested fp. This is the
    // intended use of `ambientFrameKey` and should keep working.
    const withFrameA = (
      <PartialRoot>
        <Partial selector="#outer" frame="outer" frameUrl="/a">
          <Partial selector="#inner">
            <span>inner body</span>
          </Partial>
        </Partial>
      </PartialRoot>
    );
    const withFrameB = (
      <PartialRoot>
        <Partial selector="#outer" frame="outer" frameUrl="/b">
          <Partial selector="#inner">
            <span>inner body</span>
          </Partial>
        </Partial>
      </PartialRoot>
    );

    const fpA = await renderFp(
      "http://localhost/",
      withFrameA,
      "inner",
    );
    clearRegistry();
    const fpB = await renderFp(
      "http://localhost/",
      withFrameB,
      "inner",
    );

    expect(fpA).toBeTruthy();
    expect(fpB).toBeTruthy();
    expect(fpA).not.toBe(fpB);
  });
});
