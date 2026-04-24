/**
 * RSC integration test for content accessors inside a `<Partial cmsId>`.
 *
 * Renders a server tree through the in-process Flight helper
 * (`src/test/rsc-server.ts`), asserting that `getText` / `getEnum` /
 * `getNumber` inside a Partial body resolve against the CMS store
 * based on the current request. Covers three shapes in one pass:
 *
 *   1. A Partial without `cmsId` — accessors return empty / default
 *      values, no scope is opened.
 *   2. A Partial with `cmsId` and no request-input config — global
 *      content from the default config.
 *   3. A Partial with `cmsId` whose store has per-slug configs —
 *      resolved against `pathname:/cms-demo/:slug`, cascade picks the
 *      most-specific match.
 */
import { describe, expect, it, beforeEach, vi } from "vitest";

// `cache.tsx` imports `@vitejs/plugin-rsc/rsc` which resolves to a
// `virtual:` module the Node ESM loader can't handle. Bypass-mock
// matches the pattern in `partial-frame-scope.rsc.test.tsx` —
// cache semantics aren't on this test's path (cmsId doesn't touch
// the cache manifest).
vi.mock("../cache.tsx", () => ({
  Cache: ({ children }: { children: React.ReactNode }) => children,
  _cacheStats: async () => ({ size: 0, keys: [] }),
  _clearCache: async () => {},
}));

import {
  getEnum,
  getNumber,
  getText,
} from "../../framework/context.ts";
import { Partial, PartialRoot } from "../partial.tsx";
import { ROOT } from "../partial-context.ts";
import { clearRegistry } from "../partial-registry.ts";
import { flightToString, renderWithRequest } from "../../test/rsc-server.ts";

beforeEach(() => {
  clearRegistry();
});

// Each block emits its fields as one interpolated string so Flight
// encodes them as a single child (rather than an array of siblings
// split by commas) — makes `text.includes(...)` assertions robust.

function NoCmsBlock() {
  const headline = getText("headline");
  return <div>{`no-cms:${headline || "empty"}`}</div>;
}

function HeroBlock() {
  const headline = getText("headline");
  const tone = getEnum("tone", ["calm", "loud"] as const);
  return <div>{`hero:${headline}|tone:${tone}`}</div>;
}

function GreetingBlock() {
  const headline = getText("headline");
  const body = getText("body");
  const accent = getNumber("accent");
  return (
    <div>{`greeting:${headline}|body:${body}|accent:${accent}`}</div>
  );
}

async function renderToText(url: string, node: React.ReactNode): Promise<string> {
  const { stream } = await renderWithRequest(url, node);
  return flightToString(stream);
}

describe("CMS content accessors inside <Partial cmsId>", () => {
  it("accessors outside a CMS scope return empty values and don't throw", async () => {
    const tree = (
      <PartialRoot>
        <Partial parent={ROOT} selector="#no-cms">
          <NoCmsBlock />
        </Partial>
      </PartialRoot>
    );
    const text = await renderToText("http://localhost/cms-demo", tree);
    expect(text).toContain("no-cms:empty");
  });

  it("global-config Partial resolves the default fields", async () => {
    const tree = (
      <PartialRoot>
        <Partial parent={ROOT} selector="#hero" cmsId="cms-demo-hero">
          <HeroBlock />
        </Partial>
      </PartialRoot>
    );
    const text = await renderToText("http://localhost/cms-demo", tree);
    expect(text).toContain("hero:Welcome to the CMS demo");
    expect(text).toContain("tone:calm");
  });

  it("per-slug Partial picks the exact-match config on /cms-demo/alpha", async () => {
    const tree = (
      <PartialRoot>
        <Partial
          parent={ROOT}
          selector="#greeting"
          cmsId="cms-demo-greeting"
        >
          <GreetingBlock />
        </Partial>
      </PartialRoot>
    );
    const text = await renderToText("http://localhost/cms-demo/alpha", tree);
    expect(text).toContain("greeting:Hello, Alpha!");
    expect(text).toContain("accent:3");
  });

  it("per-slug Partial picks the {in: [...]} config on /cms-demo/beta", async () => {
    const tree = (
      <PartialRoot>
        <Partial
          parent={ROOT}
          selector="#greeting"
          cmsId="cms-demo-greeting"
        >
          <GreetingBlock />
        </Partial>
      </PartialRoot>
    );
    const text = await renderToText("http://localhost/cms-demo/beta", tree);
    expect(text).toContain("greeting:Beta/Gamma view");
  });

  it("per-slug Partial falls through to the default config on an unmatched slug", async () => {
    const tree = (
      <PartialRoot>
        <Partial
          parent={ROOT}
          selector="#greeting"
          cmsId="cms-demo-greeting"
        >
          <GreetingBlock />
        </Partial>
      </PartialRoot>
    );
    const text = await renderToText("http://localhost/cms-demo/zulu", tree);
    expect(text).toContain("greeting:Default greeting");
    expect(text).toContain("accent:1");
  });

  it("sibling Partials with different cmsIds don't leak fields across scopes", async () => {
    const tree = (
      <PartialRoot>
        <Partial parent={ROOT} selector="#hero" cmsId="cms-demo-hero">
          <HeroBlock />
        </Partial>
        <Partial
          parent={ROOT}
          selector="#greeting"
          cmsId="cms-demo-greeting"
        >
          <GreetingBlock />
        </Partial>
      </PartialRoot>
    );
    const text = await renderToText("http://localhost/cms-demo/alpha", tree);
    expect(text).toContain("hero:Welcome to the CMS demo");
    expect(text).toContain("greeting:Hello, Alpha!");
  });
});
