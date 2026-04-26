/**
 * Regression cover for `<Partial varyOn>`:
 *
 *   1. A Partial declaring `varyOn=["url:foo"]` produces distinct
 *      fingerprints for two requests differing only in `?foo=`. The
 *      structural fp (used for `<Cache>` baseKey) and the full fp
 *      (used for fp-skip) must both differ.
 *
 *   2. An ancestor whose JSX is unchanged but contains a descendant
 *      `<Partial varyOn=…>` propagates the descendant's resolved
 *      values into its OWN fp — so a fp-skip at the ancestor would
 *      be safe (or rather, would not happen, because the URL change
 *      bumps the ancestor's fp too). Without this propagation the
 *      ancestor short-circuits descendant rendering.
 *
 *   3. Frame-aware resolution: a Partial with `frame=` sees its own
 *      frame's URL when resolving varyOn; a Partial with no `frame`
 *      but inside a framed ancestor sees the ambient frame's URL
 *      (looked up via parent.frameChain — bypasses the leaky
 *      React.cache cell).
 */
import { describe, expect, it, beforeEach, vi } from "vitest";

vi.mock("../cache.tsx", () => ({
  Cache: ({ children }: { children: React.ReactNode }) => children,
  _cacheStats: async () => ({ size: 0, keys: [] }),
  _clearCache: async () => {},
}));

import { renderWithRequest } from "../../test/rsc-server.ts";
import { PartialRoot, Partial } from "../partial.tsx";
import { ROOT } from "../partial-context.ts";
import { clearRegistry } from "../partial-registry.ts";

beforeEach(() => {
  clearRegistry();
});

function extractFingerprint(text: string, partialId: string): string | null {
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

describe("Partial fingerprint — varyOn", () => {
  it("URL change in a declared varyOn key produces a distinct fingerprint", async () => {
    const tree = (
      <PartialRoot>
        <Partial parent={ROOT} selector="#fields" varyOn={["url:config"]}>
          <span>body</span>
        </Partial>
      </PartialRoot>
    );

    const fpA = await renderFp(
      "http://localhost/?config=0",
      tree,
      "fields",
    );
    clearRegistry();
    const fpB = await renderFp(
      "http://localhost/?config=1",
      tree,
      "fields",
    );

    expect(fpA).toBeTruthy();
    expect(fpB).toBeTruthy();
    expect(fpA).not.toBe(fpB);
  });

  it("URL change in an UNDECLARED key leaves the fingerprint unchanged", async () => {
    const tree = (
      <PartialRoot>
        <Partial parent={ROOT} selector="#fields" varyOn={["url:select"]}>
          <span>body</span>
        </Partial>
      </PartialRoot>
    );

    const fpA = await renderFp(
      "http://localhost/?select=a&unrelated=x",
      tree,
      "fields",
    );
    clearRegistry();
    const fpB = await renderFp(
      "http://localhost/?select=a&unrelated=y",
      tree,
      "fields",
    );

    expect(fpA).toBeTruthy();
    expect(fpB).toBeTruthy();
    expect(fpA).toBe(fpB);
  });

  it("ancestor fp captures a descendant's varyOn (static-walk path)", async () => {
    // Ancestor's own JSX shape is identical across both renders. Only
    // the descendant's `?config=` varies. With the descendant fold in
    // place, the ancestor's fp must differ — otherwise an ancestor
    // fp-skip would short-circuit the descendant's re-render.
    const tree = (
      <PartialRoot>
        <Partial parent={ROOT} selector="#root">
          <div>
            <Partial parent={ROOT} selector="#fields" varyOn={["url:config"]}>
              <span>body</span>
            </Partial>
          </div>
        </Partial>
      </PartialRoot>
    );

    const fpA = await renderFp("http://localhost/?config=0", tree, "root");
    clearRegistry();
    const fpB = await renderFp("http://localhost/?config=1", tree, "root");

    expect(fpA).toBeTruthy();
    expect(fpB).toBeTruthy();
    expect(fpA).not.toBe(fpB);
  });

  it("ambient frame: a Partial inside a frame resolves its varyOn against the frame URL", async () => {
    // Two renders differ only in the FRAME URL. The inner Partial
    // (no own frame) declares `varyOn=["url:q"]`. Resolution must use
    // the framed ancestor's URL — not the page URL — so a frame-URL
    // query change produces a distinct fp.
    const treeA = (
      <PartialRoot>
        <Partial
          parent={ROOT}
          selector="#outer"
          frame="outer"
          frameUrl="/?q=alpha"
        >
          <Partial parent={ROOT} selector="#inner" varyOn={["url:q"]}>
            <span>inner</span>
          </Partial>
        </Partial>
      </PartialRoot>
    );
    const treeB = (
      <PartialRoot>
        <Partial
          parent={ROOT}
          selector="#outer"
          frame="outer"
          frameUrl="/?q=beta"
        >
          <Partial parent={ROOT} selector="#inner" varyOn={["url:q"]}>
            <span>inner</span>
          </Partial>
        </Partial>
      </PartialRoot>
    );

    // Page URL identical in both renders — only the frame URL differs.
    const fpA = await renderFp("http://localhost/", treeA, "inner");
    clearRegistry();
    const fpB = await renderFp("http://localhost/", treeB, "inner");

    expect(fpA).toBeTruthy();
    expect(fpB).toBeTruthy();
    expect(fpA).not.toBe(fpB);
  });
});
