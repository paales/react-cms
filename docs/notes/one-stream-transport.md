# One stream for everything — transport consolidation

Status: **active design**, opened 2026-07-08. Supersedes the "attach +
POST-envelope" split as the *conceptual* model; the fetch transport
stays as the default implementation under a new transport seam.

## Thesis

Every client↔server exchange rides ONE persistent connection:

- **Downstream** — a single held stream, opened once per page and held
  for the page lifetime, carrying EVERYTHING the server sends back:
  the initial whole-tree segment, per-parton lanes, navigation
  segments, **server-action render consequences**, and **cookie
  deltas**. No re-attach churn, no per-interaction response bodies.
- **Upstream** — statements the client sends: visibility, url,
  ack, telemetry, cancel, **server-action invocations**, **client
  cookie changes**. Fire-and-forget today (POST envelopes); a
  full-duplex transport folds this into the same connection.

Nothing the client does gets an RSC body back over HTTP. A POST action
returns at most its *function return value* (data the caller awaited) —
never render output. Renders only ever arrive downstream.

The connection is "just" HTTP: a torn one **re-establishes**, it never
permanently degrades. Document-navigation fallback is the last resort
after the transport proves *structurally* impossible (POST path
blocked), not the response to a single transient failure.

Transport is **pluggable**: fetch (default, HTTP/1.1+), WebSocket
(full-duplex), WebTransport (HTTP/3). The channel *semantics* —
frames, delivery seqs, acks, the connection-session mirror — are
transport-agnostic; only the byte/message plumbing swaps.

## Why (the bet)

A server lives at every edge. A held connection costs ~little (W3
soak: ~KB/idle-connection, one core → many thousands). Collapsing the
protocol onto it removes whole categories of round-trip and state-sync:
the URL, cookies, visibility, analytics, and action consequences stop
being separate mechanisms and become frames. The payoff is *dynamic
range* — the same primitive from a lean storefront to a realtime
dashboard — without bifurcating the stack.

## Current architecture (what we're consolidating)

- Upstream: `POST /__parton/channel`, a `{connection, seq, frames}`
  JSON envelope, fire-and-forget, rAF-coalesced
  ([[channel-client]]/[[channel-protocol]]).
- Downstream: held segmented byte stream from `POST /__parton/live`
  (attach), markers (`conn`/`delivery-seq`/`lanes-open`/`mux`/`next`/
  `settled`) + Flight rows, split client-side
  ([[segmented-response]]/browser entry `handleLane`/`onWireEntry`).
- Actions: `POST` action endpoint returns the consequence **segment in
  the response body** + `x-parton-consequences` header naming reserved
  delivery seqs.
- Cookies: read from the request `Cookie` header (tracked `cookie()`
  hook) plus a mutable connection overlay for held-stream reads (P0e);
  a client cookie change rides an upstream `cookie` frame, not a tear.
  Server writes still land via the setCookie overlay → `Set-Cookie`.
- Lifecycle: 20s idle keepalive closes the stream; a 5s heartbeat tick
  reopens it; a first-ack deadline + failed-first-ack-envelope path
  **degrades the page permanently** to document navigation.

## The plan

Six P0 changes make the *fetch* transport "one stream always"; P1/P2
add the full-duplex transports behind a seam.

### P0a — recoverable degradation (task #18)

**Problem.** `markPageDegraded()` is page-lifetime sticky. Triggers:
(1) a failed envelope carrying the connection's FIRST ack
(`channel-client.ts` ~1511) — "duplex broken"; (2) an
interaction-riding attach that never established
(`_channelConnectionClosed`, ~1399). Both treat a *single* failure as
proof the transport is impossible and fall back to document navigation
for the whole page life. But the connection is just HTTP — a torn one
should re-establish.

**Change.** Replace sticky degrade with **bounded re-establishment**:

- On a failed first-ack envelope / never-established attach, do NOT set
  `degraded`. Instead schedule a re-attach with backoff (immediate,
  then exponential up to a cap). The heartbeat already re-attaches on
  `_channelConnectionClosed` → `_requestAttachNow`; make the failure
  paths route there instead of to `markPageDegraded`.
- Keep a **failure counter**; only after N consecutive *establishment*
  failures (the attach POST itself erroring, or conn never arriving —
  the signature of a genuinely blocked `/__parton/*` path) fall to
  document-nav mode. That fallback stays *recoverable*: a later
  successful attach clears it.
- Pending nav/refetch records during a re-establishment window LATCH
  (they already do) and ride the next attach, rather than being flushed
  to document navigation on the first stumble.

Distinguish **transient** (connection torn, envelope lost once) from
**structural** (POST returns HTML/redirect, or repeated conn-timeouts)
— only structural earns document-nav, and even then re-probe.

### P0b — no first-nav churn (task #19)

**Problem.** The boot attach opens in CATCH-UP mode (document anchor →
straight into the lane loop, no initial segment). A **silent** nav
pre-establishment gates its window-nav claim on `_channelNavAvailable()`
(`browser.tsx` ~847/862), which is false until established — so it
does NOT claim, and the heartbeat's `onNavigate` aborts the in-flight
boot attach and re-attaches. First real user nav that lands
pre-establishment, or after the boot stream closed on keepalive,
"stops the live request and starts a new one." Later navs (established,
stream held) ride it.

**Change.** Fold pre-establishment navigations INTO the in-flight boot
attach instead of tearing it:

- Set the window-nav claim **unconditionally** for real navigations
  (already true at `browser.tsx` ~962) AND for silent navs regardless
  of establishment — a latched statement will ride whatever attach is
  in flight/next, so the boot attach must never be aborted for it.
- The catch-up (lane-loop) stream already serves navigations via
  `handleNavigation`/`emitNavSegment`; confirm a url frame arriving on
  a catch-up connection reopens with a whole-tree nav segment (it moves
  `session.routeKey`), so no re-attach is needed to change route.
- Net: the boot stream is the ONLY stream; every nav's segment arrives
  on it.

### P0c — hold one downstream indefinitely (task #20)

**Problem.** The 20s idle keepalive + 5s reopen cycle is deliberate
churn (server-memory management). "One stream always" wants the stream
held for the page lifetime.

**Change.** Raise the idle keepalive to page-lifetime (or gate close on
`document.visibilityState`/`pagehide` rather than a 20s idle timer).
Keep the 30s whole-tree **reconcile** cadence — it's the drift healer a
never-reopening connection needs (`segmented-response.ts` ~211). Watch
the W3 soak budget: the tradeoff (more held connections) is the
accepted bet, but the bench must still pass. This is the change with
the clearest resource cost — validate against `bench/` + the soak
category before merging.

**Shipped (Option A — `DEFAULT_KEEPALIVE_MS` = 5 min).** The survey
reframed the keepalive: it is NOT a routine liveness cycle but a
BACKSTOP for a genuinely-abandoned connection whose `detach` was lost
AND whose held-stream `cancel()` never fired. The common teardowns
already reap promptly and independently of the value — `pagehide`
`detach` → `session.detached` (loop exits at its next wake), a torn
held stream → `demand.cancelled` (surfaced at the next lane enqueue) —
and an active page never reaches the deadline (shipped lanes re-anchor
it; the 30s reconcile heals drift). So the 20s value only bought a
close+reopen churn on an idle-but-alive page for no benefit. Raising to
5 min holds one stream for any real session while still reaping a
leaked connection in bounded time. Option B (page-lifetime + a
downstream keepalive PING) was rejected as not clearly clean: a
downstream write to an abandoned-but-un-RST socket sits in the send
buffer until TCP retransmit timeout (minutes) — it is not a reliable
prompt abandonment detector, so it adds machinery without bounding
abandonment better than the timer. A side-effect win: an idle
connection now lives long enough to hit the 30s reconcile cadence, so
it heals on-stream instead of only at a reopen. The `_setKeepaliveMs`
override is unchanged and now also reachable over HTTP for the e2e tier
(`GET /__test/set-keepalive?ms=`, DEV-only) — the chat-overlay-remount
spec brackets its run with the old 20s window, which it needs to force
a chat-closed connection to idle out and reopen chat-aware.

### P0d — actions return no RSC; consequences downstream (task #23)

**The machinery already exists — this is a policy flip, not new wiring.**
Survey findings:
- The action POST body today is one `RscPayload` = `{ root: <Root/>,
  returnValue, formState }`. `root` is a whole-tree re-render — the
  render CONSEQUENCES, in-body. `returnValue` (`{ok,data}`) is the
  caller's data. `formState` is the `<form action>` path.
- On an ATTACHED page the invalidation consequences ALREADY lane on the
  held stream: `_reserveActionConsequences(conn)` mints
  `session.assignedLaneSeqs` (`segmented-response.ts:2826`), returned as
  the `x-parton-consequences` header; the transaction-commit wake
  re-renders each invalidated parton on the held stream consuming its
  reserved seq. The optimistic overlay holds on the held-stream
  watermark (`_awaitActionConsequences`), NOT the body.
- The **deferred-only** path already suppresses the body root:
  `_actionSuppressesCommit()` (`context.ts:390`) → `root: null`
  (`rsc.tsx:359`). That is the existing template for body-less.

**Change.** Make EVERY attached action behave like the deferred-only
path: when `consequenceConn != null`, set `suppressRoot = true` always,
so the body carries only `returnValue` + `formState` + any url-trailer
— never a `<Root/>` render. The held stream is the sole consequence
carrier (it already is, for the overlay). Keep the in-body `<Root/>`
for the UNATTACHED/degraded path (no held stream to carry it). The
double-delivery (body render AND lanes) that exists today collapses to
lanes-only. Net: an action POST returns a few bytes of return value,
never RSC content.

### P0e — cookies on the protocol (task #24) — UPSTREAM SHIPPED

**The upstream tear is gone; the downstream write stays a header.**

Shipped (`cookie` frame kind, `channel-protocol.ts`):
1. **Mutable session cookie overlay.** `ConnectionSession.cookies` is a
   DELTA (name → value, `null` a tombstone) over the attach's open-time
   `Cookie` header. `parseCookies` layers it between the raw header and
   the per-request `setCookie` writes, so every held-stream `cookie()`
   read — the hook, `evalDepKeys`' fold, the cell-partition scope —
   reflects a change without a reattach. No tear.
2. **Upstream `cookie` frame.** `applyClientCookies` writes
   `document.cookie` and `_channelCookieChange` states each change as a
   reliable-class `cookie` frame on the OPEN connection (retires at the
   attach subsume — the attach's own header restates the jar).
   `handleChannelPost` applies it to the overlay and queues the name;
   the driver lanes EXACTLY the snapshots whose tracked `cookie:<name>`
   deps name it (`_routeMatchingCookieIds`) — per CONNECTION (the
   flip-wake arm, never a process-global `refreshSelector` that would
   wake every peer). Their fp folds the overlay through `parseCookies`,
   so a changed value re-renders and an unchanged one fp-skips. Match
   gates keep reading the raw jar (`parseRawCookies`, `match.ts`) — "who
   you were when you asked" — so a delta re-renders `cookie()` bodies,
   never a parked variant's existence gate (a gate-flipping cookie
   materializes at the next attach's whole-tree render).

**Downstream stays a header (documented split).** A server cookie write
on the channel/held path is the session-mint `Set-Cookie` on the
endpoint `204` / attach / document response — kept as a header because
the minted session cookie must reach the client SYNCHRONOUSLY for the
next envelope's binding (§Security); a downstream frame is async and
would 404 the binding in the gap. App-cookie downstream framing is
designed (the `cookie` frame is bidirectional in grammar) but has no
in-tree writer — a held render writing an app cookie — to justify a
downstream producer yet (YAGNI). Add it when a real caller appears.

Sequenced AFTER P0a-c: it depends on the held stream being stable
(no churn) to be worth doing — otherwise the tear-and-reattach it
replaces is masked by the churn P0a-c removes.

### P1 — pluggable transport seam + WebSocket (task #21)

**The seam is small because the byte pipeline is already
transport-agnostic.** Survey findings that shape it:

- Server: `driveSegmentedResponse(controller, renderSegment, _, demand)`
  (`segmented-response.ts:337`) touches ONLY `controller.enqueue(bytes)`
  and `demand: {cancelled, pulled()}`. It never names `Response`. The
  HTTP coupling is two layers out: `createSegmentedResponse` (`:269`,
  adapts driver→`ReadableStream`) then `new Response(...)`
  (`rsc.tsx:270`). So a WS/WebTransport downstream is a drop-in at
  `createSegmentedResponse`: supply an `enqueue` that does `ws.send`
  and a `demand` tied to socket writable-backpressure.
- Client downstream: `consumeLiveStream(statement, signal)`
  (`browser.tsx:219`) reads `fetch(ATTACH).body` then
  `splitSegments(stream, …)`. Parameterize the stream SOURCE; the
  `\xFF`-marker splitter (`fp-trailer-marker.ts`/`fp-trailer-split.ts`)
  stays.
- Client upstream: `postEnvelope(envelope): Promise<boolean>`
  (`channel-client.ts:1545`) is the only upstream fetch; the 204-vs-else
  boolean is the whole contract. Everything above it is transport-free.
- Server upstream: the frame-apply `switch`
  (`connection-session.ts:937-979`) over `(decodedEnvelope, session)`.

**Decision: OPAQUE TUNNEL, not native message framing.** The WS /
WebTransport carries the SAME `\xFF`-marker byte stream. Reframing each
marker as its own message (replacing `buildMarker`/`tryReadMarker`/
`SegmentIterator`/`_channelWireEntry`) buys nothing the seam needs and
multiplies risk. Keep the bytes; swap only the pipe.

**`ChannelTransport` interface** (client):
```
interface ChannelTransport {
  // downstream: hand back a byte stream of the same marker wire.
  open(statement: AttachStatement, signal: AbortSignal):
    Promise<{ body: ReadableStream<Uint8Array> }>
  // upstream: deliver one envelope; boolean = "server will see it".
  send(envelope: ChannelEnvelope): Promise<boolean>
  close(): void
}
```
- **Fetch transport** (default, extract from today's code): `open` =
  `fetch(ATTACH_ENDPOINT, POST json).body`; `send` = `postEnvelope`
  (204→true). Behavior-preserving — all gates green BEFORE the WS
  transport lands.
- **WebSocket transport**: one full-duplex socket. `open` upgrades the
  socket, sends the `AttachStatement` as the first message, returns a
  `ReadableStream` fed by `ws.onmessage` (server tunnels the marker
  bytes). `send` = `ws.send(JSON.stringify(envelope))` → true (the
  retransmit buffer + `applied` marker already carry reliability, so
  fire-and-forget is fine; no per-message 204 needed). `close` =
  `ws.close`. Full-duplex folds up+down into ONE connection: the
  server tunnels `driveSegmentedResponse` bytes down the socket and
  feeds `onmessage` envelopes into the frame-apply switch — no separate
  attach/channel endpoints.

**Server wiring (the real work): a FOURTH hook.** `createRscHandler`
returns `{fetch}`; a socket server lives OUTSIDE that Request→Response
surface. Add a `createChannelServer({Root})` that owns the socket:
- Dev/preview: a Vite plugin `configureServer`/`configurePreviewServer`
  hook onto the Node http server's `upgrade` event (WS handshake).
- Per connection: on open, run `driveSegmentedResponse(enqueue=ws.send,
  demand=wsBackpressure, renderSegment)`; on message, decode envelope →
  frame-apply switch. Reuse `openLiveConnectionSession` unchanged.
- Selection: the client picks a transport (WS if `new WebSocket` +
  endpoint reachable, else fetch); the heartbeat/`fireAttach` drive the
  chosen transport's `open`. Default stays fetch until WS proven.

### P2 — WebTransport (task #22)

Same seam, same opaque tunnel — a WebTransport session's bidirectional
stream carries the marker bytes; lossy frames (visibility) MAY use
datagrams later. `open` = `new WebTransport(url)` →
`session.createBidirectionalStream()`; downstream = the stream's
readable; upstream `send` = write the envelope to the stream's
writable. `driveSegmentedResponse` unchanged (`enqueue` = stream
writer).

**Infra blocker (honest):** WebTransport needs HTTP/3 (QUIC). Vite
dev/preview is Node HTTP/1.1; Node has no stable WebTransport server.
So P2 is: implement the client transport + server driver-tunnel behind
the seam, ship it disabled-by-default, and document the QUIC server
requirement (e.g. a standalone `@fails-components/webtransport` Node
server, or deploy behind an HTTP/3 edge). Verified only to the extent
the environment allows — the seam guarantees it's a pipe swap, not a
protocol rewrite.

## Testing strategy

Every change gates on the FULL surface before merge — the channel's
invariants are guarded by all three:

- `yarn test` (typecheck + node + rsc tiers) — the in-process Flight
  harness exercises delivery seqs, acks, fp-skip, nav segments.
- `yarn test:e2e` — real navigation, actions, frames.
- `yarn build:website && node website/validate-world.mjs` — the
  streaming/culling/keepalive soak gate; the canary for P0c especially.
- `yarn bench:server` soak category for P0c connection cost.

No change merges red. Transient-flake protocol per CLAUDE.md.

## Sequencing

P0a → P0b → P0c are independent and land first (they harden the single
stream). P0d/P0e ride on the held stream P0a-c stabilize. P1 seam is a
refactor that must be behavior-preserving for the fetch transport
(all gates green) before the WS transport slots in. P2 last.
