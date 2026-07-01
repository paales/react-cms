/**
 * Auto-tracked vary parity — a hooks-only parton (tracked reads in its
 * Render body, no `vary` option) behaves like its declared-`vary` twin
 * across the full fp-skip lifecycle:
 *
 *   - fp stable while the tracked value is stable (warm renders),
 *   - fp-skip when the client declares the matching `?cached=` fp,
 *   - fresh render when the tracked value changes under that same
 *     `?cached=` declaration,
 *   - the descendant fold moves an ancestor's fp when a nested
 *     hooks-only spec's read changes — and un-skips the ancestor.
 *
 * The one intended divergence is cold-render lag: a hooks-only spec's
 * FIRST render of a variant has no recorded deps, so its emitted fp
 * differs from every later (deps-folded) render. That drift is shipped
 * to the client by the fp-trailer in the same response (see
 * fp-trailer.ts `computeFpUpdates`); here it surfaces as `fp(r1) !==
 * fp(r2)` and is asserted explicitly so the lag stays a documented
 * contract, not an accident. See docs/notes/auto-tracked-vary.md.
 *
 * Also covers the two tracked-read hooks that complete the VaryScope
 * surface: `header()` (request header) and `pathname()` (whole-path
 * dependence, the escape hatch for wildcard tails).
 */

import { describe, expect, it, beforeEach } from "vitest"
import { parton, PartialRoot, type RenderArgs, type VaryScope } from "../partial.tsx"
import { renderWithRequest } from "../../test/rsc-server.ts"
import { clearRegistry } from "../partial-registry.ts"
import { cookie, header, pathname, searchParam } from "../server-hooks.ts"
import { hash } from "../hash.ts"
import { stableStringify } from "../stable-stringify.ts"

function fpById(flight: string): Map<string, string> {
  const out = new Map<string, string>()
  const re = /"partialId":"([^"]+)","partialFingerprint":"([^"]+)"/g
  let m: RegExpExecArray | null
  while ((m = re.exec(flight)) !== null) out.set(m[1], m[2])
  return out
}

async function flightAt(
  url: string,
  node: React.ReactNode,
  headers?: Record<string, string>,
): Promise<string> {
  const { stream } = await renderWithRequest(url, node, { headers })
  return await new Response(stream).text()
}

/** matchKey for a spec with no own match and no match-bearing ancestor. */
const ROOT_MK = hash(stableStringify({}))

// ── Twins: declared `vary` vs hooks-only, same cookie dependence ──────

const DeclaredCookie = parton(
  function DeclaredCookieRender({ pref }: { pref: string } & RenderArgs) {
    return <span>{`declared-cookie-body:${pref}`}</span>
  },
  {
    selector: "#atv-declared-cookie",
    vary: ({ cookies: { pref } }: VaryScope) => ({ pref: pref ?? "" }),
  },
)

const HooksCookie = parton(
  function HooksCookieRender(_: RenderArgs) {
    const pref = cookie("pref") ?? ""
    return <span>{`hooks-cookie-body:${pref}`}</span>
  },
  { selector: "#atv-hooks-cookie" },
)

/**
 * Drive one spec through the fp-skip lifecycle and return what
 * happened at each step: cold render, two warm renders (a hooks-only
 * spec's deps fold from render 2), a `?cached=` visit with the same
 * cookie (skip expected), and one with a changed cookie (fresh render
 * expected).
 */
async function lifecycle(
  tree: React.ReactNode,
  id: string,
  bodyMarker: string,
): Promise<{
  coldFp: string | undefined
  warmFp: string | undefined
  warmFp2: string | undefined
  skippedWhenCachedSameValue: boolean
  freshWhenCachedChangedValue: boolean
  changedBody: string
}> {
  const url = "http://t/atv"
  const r1 = await flightAt(url, tree, { cookie: "pref=a" })
  const coldFp = fpById(r1).get(id)
  const r2 = await flightAt(url, tree, { cookie: "pref=a" })
  const warmFp = fpById(r2).get(id)
  const r3 = await flightAt(url, tree, { cookie: "pref=a" })
  const warmFp2 = fpById(r3).get(id)
  // Client declares the warm fp as cached → same cookie → fp matches →
  // the server must emit a placeholder, not the body.
  const skipped = await flightAt(`${url}?cached=${id}:${ROOT_MK}:${warmFp}`, tree, {
    cookie: "pref=a",
  })
  // Same cached declaration, changed cookie → fp mismatch → fresh body.
  const fresh = await flightAt(`${url}?cached=${id}:${ROOT_MK}:${warmFp}`, tree, {
    cookie: "pref=b",
  })
  return {
    coldFp,
    warmFp,
    warmFp2,
    skippedWhenCachedSameValue: !skipped.includes(bodyMarker),
    freshWhenCachedChangedValue: fresh.includes(bodyMarker),
    changedBody: fresh,
  }
}

describe("hooks-only parton matches its declared-vary twin through the fp-skip lifecycle", () => {
  beforeEach(() => clearRegistry("all"))

  it("declared-vary twin: stable fp, fp-skip on match, fresh render on cookie change", async () => {
    const tree = (
      <PartialRoot>
        <DeclaredCookie />
      </PartialRoot>
    )
    const r = await lifecycle(tree, "atv-declared-cookie", "declared-cookie-body")
    expect(r.warmFp).toBeDefined()
    expect(r.coldFp).toBe(r.warmFp) // declared vary folds from render 1
    expect(r.warmFp2).toBe(r.warmFp)
    expect(r.skippedWhenCachedSameValue).toBe(true)
    expect(r.freshWhenCachedChangedValue).toBe(true)
    expect(r.changedBody).toContain("declared-cookie-body:b")
  })

  it("hooks-only twin: same skip/refetch behavior; cold fp lags one render (trailer's job)", async () => {
    const tree = (
      <PartialRoot>
        <HooksCookie />
      </PartialRoot>
    )
    const r = await lifecycle(tree, "atv-hooks-cookie", "hooks-cookie-body")
    expect(r.warmFp).toBeDefined()
    // Cold-render lag: render 1 folded no deps, so its emitted fp
    // differs from the deps-folded warm fp. The fp-trailer ships this
    // cold→warm drift to the client within the same response.
    expect(r.coldFp).not.toBe(r.warmFp)
    expect(r.warmFp2).toBe(r.warmFp) // stable once warm
    expect(r.skippedWhenCachedSameValue).toBe(true)
    expect(r.freshWhenCachedChangedValue).toBe(true)
    expect(r.changedBody).toContain("hooks-cookie-body:b")
  })
})

describe("cold-record gate: no snapshot → no skip for a hooks-only spec", () => {
  beforeEach(() => clearRegistry("all"))

  it("declines the skip on a cold process even when the client-cached dep-less fp matches", async () => {
    const tree = (
      <PartialRoot>
        <HooksCookie />
      </PartialRoot>
    )
    const url = "http://t/atv-cold"
    // Warm client state at pref=a: the COLD fp (dep-less) is what the
    // boundary emitted on render 1.
    const r1 = await flightAt(url, tree, { cookie: "pref=a" })
    const coldFp = fpById(r1).get("atv-hooks-cookie")
    expect(coldFp).toBeDefined()

    // Server "restarts": registry wiped, but the client still declares
    // the dep-less fp. The recomputed fp folds no deps (no snapshot) so
    // it MATCHES — but the read values may have changed (pref=b here).
    // The gate must decline the skip and render fresh, correct bytes.
    clearRegistry("all")
    const fresh = await flightAt(`${url}?cached=atv-hooks-cookie:${ROOT_MK}:${coldFp}`, tree, {
      cookie: "pref=b",
    })
    expect(fresh).toContain("hooks-cookie-body:b")
  })

  it("declines the skip on a first visit to a NEW route bucket when the spec has a dep record elsewhere", async () => {
    // Wildcard match so two URLs land in different route buckets (the
    // deeper URL matches a different registered-pattern set). The
    // snapshot record is bucket-scoped, so the first visit to the new
    // bucket computes a dep-less fp — which collides with the dep-less
    // fp the client cached from the OTHER bucket. Evidence from the
    // committed variants (this id HAS tracked reads) must decline the
    // skip.
    const GateTail = parton(
      function GateTailRender(_: RenderArgs) {
        return <span>{`gate-tail-body:${cookie("pref") ?? ""}`}</span>
      },
      { selector: "#atv-gate-tail", match: "/gate{/*}?" },
    )
    // A sibling with a deeper match makes /gate vs /gate/p/3 distinct
    // route buckets (different matched-pattern sets).
    const GateDeep = parton(
      function GateDeepRender(_: RenderArgs) {
        return <span>deep</span>
      },
      { selector: "#atv-gate-deep", match: "/gate/p/:n" },
    )
    const tree = (
      <PartialRoot>
        <GateTail />
        <GateDeep />
      </PartialRoot>
    )
    const r1 = await flightAt("http://t/gate", tree, { cookie: "pref=a" })
    const coldFp = fpById(r1).get("atv-gate-tail")
    expect(coldFp).toBeDefined()

    // First visit to the /gate/p/3 bucket, cookie changed. Without the
    // evidence check the dep-less fps collide and the stale `a` body
    // would be skipped-in; the gate must render fresh `b` bytes.
    const fresh = await flightAt(`http://t/gate/p/3?cached=atv-gate-tail:${ROOT_MK}:${coldFp}`, tree, {
      cookie: "pref=b",
    })
    expect(fresh).toContain("gate-tail-body:b")
  })

  it("a declared-vary spec keeps the cold-process skip (request-reproducible fp)", async () => {
    const tree = (
      <PartialRoot>
        <DeclaredCookie />
      </PartialRoot>
    )
    const url = "http://t/atv-cold-declared"
    const r1 = await flightAt(url, tree, { cookie: "pref=a" })
    const fp = fpById(r1).get("atv-declared-cookie")
    expect(fp).toBeDefined()

    // Same restart scenario — but a declared `vary` re-derives its full
    // surface from the request, so the fp match is trustworthy and the
    // skip goes through (placeholder, no body).
    clearRegistry("all")
    const skipped = await flightAt(`${url}?cached=atv-declared-cookie:${ROOT_MK}:${fp}`, tree, {
      cookie: "pref=a",
    })
    expect(skipped).not.toContain("declared-cookie-body")
  })
})

// ── Absence is a value: `?flag=` (empty) ≠ no `?flag` at all ──────────

const PresenceProbe = parton(
  function PresenceProbeRender(_: RenderArgs) {
    const flag = searchParam("flag")
    return <span>{flag == null ? "presence-closed" : "presence-open"}</span>
  },
  { selector: "#atv-presence" },
)

describe("dep fold distinguishes an absent read from an empty one", () => {
  beforeEach(() => clearRegistry("all"))

  it("`?flag=` and no `?flag` produce different fps (Renders branch on null-ness)", async () => {
    // A declared vary distinguished `{flag: undefined}` from
    // `{flag: ""}` through stableStringify; the dep fold must too, or a
    // dialog opened by a present-but-empty param fp-skips into its
    // closed body (the /?search= regression).
    const tree = (
      <PartialRoot>
        <PresenceProbe />
      </PartialRoot>
    )
    await flightAt("http://t/presence", tree) // cold — records search:flag
    const fpAbsent = fpById(await flightAt("http://t/presence", tree)).get("atv-presence")
    const fpEmpty = fpById(await flightAt("http://t/presence?flag=", tree)).get("atv-presence")
    const fpAbsent2 = fpById(await flightAt("http://t/presence", tree)).get("atv-presence")
    expect(fpAbsent).toBeDefined()
    expect(fpEmpty).not.toBe(fpAbsent)
    expect(fpAbsent2).toBe(fpAbsent)
  })
})

// ── header(): a tracked request-header read ───────────────────────────

const LangProbe = parton(
  function LangProbeRender(_: RenderArgs) {
    return <span>{`lang-body:${header("accept-language") ?? "none"}`}</span>
  },
  { selector: "#atv-lang" },
)

describe("header(): folds the header value into the fp", () => {
  beforeEach(() => clearRegistry("all"))

  it("fp moves when the tracked header changes, stable when it doesn't", async () => {
    const tree = (
      <PartialRoot>
        <LangProbe />
      </PartialRoot>
    )
    const url = "http://t/atv-lang"
    await flightAt(url, tree, { "accept-language": "en" }) // cold — records header:accept-language
    const fpEn = fpById(await flightAt(url, tree, { "accept-language": "en" })).get("atv-lang")
    const fpNl = fpById(await flightAt(url, tree, { "accept-language": "nl" })).get("atv-lang")
    const fpEn2 = fpById(await flightAt(url, tree, { "accept-language": "en" })).get("atv-lang")
    expect(fpEn).toBeDefined()
    expect(fpNl).not.toBe(fpEn)
    expect(fpEn2).toBe(fpEn)
  })
})

// ── pathname(): whole-path dependence (the wildcard-tail escape) ──────

const TailProbe = parton(
  function TailProbeRender(_: RenderArgs) {
    return <span>{`tail-body:${pathname()}`}</span>
  },
  // `match` with an anonymous tail — the named-params-only default
  // surface is identical across the tail values; `pathname()` is what
  // makes the tail a real dependency.
  { selector: "#atv-tail", match: "/tail{/*}?" },
)

describe("pathname(): folds the whole path into the fp", () => {
  beforeEach(() => clearRegistry("all"))

  it("fp moves across wildcard-tail URLs, stable across search-only changes", async () => {
    const tree = (
      <PartialRoot>
        <TailProbe />
      </PartialRoot>
    )
    await flightAt("http://t/tail", tree) // cold — records pathname:
    const fpBase = fpById(await flightAt("http://t/tail", tree)).get("atv-tail")
    const fpDeep = fpById(await flightAt("http://t/tail/p/3", tree)).get("atv-tail")
    const fpBase2 = fpById(await flightAt("http://t/tail?x=1", tree)).get("atv-tail")
    expect(fpBase).toBeDefined()
    expect(fpDeep).not.toBe(fpBase) // tail change is a real dependency now
    expect(fpBase2).toBe(fpBase) // search string is not part of the read
  })
})

// ── Descendant fold: a hooks-only descendant un-skips its ancestor ────

const FoldChild = parton(
  function FoldChildRender(_: RenderArgs) {
    return <span>{`fold-child-body:${cookie("pref") ?? ""}`}</span>
  },
  { selector: "#atv-fold-child" },
)
const FoldWrapper = parton(
  function FoldWrapperRender(_: RenderArgs) {
    return (
      <div>
        <span>fold-wrapper-body</span>
        <FoldChild />
      </div>
    )
  },
  { selector: "#atv-fold-wrapper" },
)

describe("descendant fold: a nested hooks-only spec's read change un-skips the wrapper", () => {
  beforeEach(() => clearRegistry("all"))

  it("wrapper fp-skips while the descendant's cookie is stable, renders fresh when it changes", async () => {
    const tree = (
      <PartialRoot>
        <FoldWrapper />
      </PartialRoot>
    )
    const url = "http://t/atv-fold"
    await flightAt(url, tree, { cookie: "pref=a" }) // cold — child records cookie:pref
    const warm = await flightAt(url, tree, { cookie: "pref=a" })
    const wrapperFp = fpById(warm).get("atv-fold-wrapper")
    expect(wrapperFp).toBeDefined()

    // Same cookie + cached wrapper fp → the wrapper (whose fold re-reads
    // the child's deps) matches and skips: neither body is emitted.
    const skipped = await flightAt(
      `${url}?cached=atv-fold-wrapper:${ROOT_MK}:${wrapperFp}`,
      tree,
      { cookie: "pref=a" },
    )
    expect(skipped).not.toContain("fold-wrapper-body")
    expect(skipped).not.toContain("fold-child-body")

    // Changed cookie: only the CHILD read it, but the wrapper's fold
    // re-reads the child's recorded deps at the current request — the
    // wrapper's fp moves, the skip is declined, and the child re-renders
    // with the new value.
    const fresh = await flightAt(
      `${url}?cached=atv-fold-wrapper:${ROOT_MK}:${wrapperFp}`,
      tree,
      { cookie: "pref=b" },
    )
    expect(fresh).toContain("fold-wrapper-body")
    expect(fresh).toContain("fold-child-body:b")
  })
})
