import { Partial } from "../../lib/partial.tsx";
import { ROOT, capturePartialContext } from "../../lib/partial-context.ts";
import { getPathname, getSearchParam } from "../../framework/context.ts";
import {
  FrameNavigateButton,
  UpdateEntryStateButton,
} from "../components/frames-demo-controls.tsx";
import { FrameNavigationBar } from "../components/frame-nav-bar.tsx";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

/**
 * `/frames-demo` — two server-iframes on a normal page.
 *
 *   • The main listing is plain page content. Product clicks drive
 *     `useNavigation().navigate("/frames-demo?product=alpha")`,
 *     which falls through to `window.navigation.navigate()` (no
 *     ambient frame in scope). Browser URL updates, browser back
 *     works, shareable link works. No inline nav bar needed — the
 *     browser is the nav bar.
 *   • `cart`  — drawer-shaped: `/cart/closed` / `/cart/open` /
 *     `/cart/checkout`.
 *   • `menu`  — `/menu/closed` / `/menu/about` / `/menu/settings`.
 *
 * Buttons inside a frame use `useNavigation()` without a name,
 * defaulting to the ambient frame. Buttons outside (e.g. product
 * buttons) do the same, getting the window-scoped handle. See
 * `notes/FRAMES.md`.
 */

// ── Main listing (plain page content — no frame) ──────────────────

function ListView() {
  const skus = ["alpha", "beta", "gamma"];
  return (
    <div data-testid="main-list">
      <h3 className="mb-2 text-base font-semibold">Product list</h3>
      <ul className="list-none space-y-1 p-0">
        {skus.map((sku) => (
          <li key={sku}>
            <FrameNavigateButton
              url={`/frames-demo?product=${sku}`}
              label={`Open ${sku}`}
              testId={`main-open-${sku}`}
            />
          </li>
        ))}
      </ul>
    </div>
  );
}

function DetailView({ sku }: { sku: string }) {
  const renderedAt = Date.now();
  return (
    <div data-testid="main-detail" data-sku={sku} data-rendered-at={renderedAt}>
      <h3 className="mb-2 text-base font-semibold">Product: {sku}</h3>
      <p className="mb-3 text-muted-foreground">
        Window URL:{" "}
        <code className="rounded bg-muted px-1.5 py-0.5 text-[0.85em] font-mono">
          ?product={sku}
        </code>{" "}
        · rendered {new Date(renderedAt).toLocaleTimeString()}
      </p>
      <FrameNavigateButton
        url="/frames-demo"
        label="← back to list"
        testId="main-back-to-list"
      />
    </div>
  );
}

function MainContent() {
  const sku = getSearchParam("product");
  return sku ? <DetailView sku={sku} /> : <ListView />;
}

// ── Cart frame content ─────────────────────────────────────────────

function CartClosedView() {
  return (
    <div
      data-testid="cart-closed"
      className="flex flex-wrap items-center gap-2 text-muted-foreground"
    >
      <span>Cart is closed.</span>
      <FrameNavigateButton
        url="/cart/open"
        label="Open cart"
        testId="cart-open-btn"
      />
    </div>
  );
}

function CartOpenView() {
  return (
    <div
      data-testid="cart-open"
      className="rounded-lg border bg-card p-4 text-card-foreground"
    >
      <h3 className="mb-2 text-base font-semibold">Cart</h3>
      <p className="mb-3 text-muted-foreground">
        0 items · rendered at {new Date().toLocaleTimeString()}
      </p>
      <div className="flex flex-wrap gap-2">
        <FrameNavigateButton
          url="/cart/checkout"
          label="Go to checkout"
          testId="cart-checkout-btn"
        />
        <FrameNavigateButton
          url="/cart/closed"
          label="Close"
          testId="cart-close-btn"
        />
        <UpdateEntryStateButton
          patch={{ itemsReady: true }}
          label="Mark ready"
          testId="cart-mark-ready"
        />
      </div>
    </div>
  );
}

function CartCheckoutView() {
  return (
    <div
      data-testid="cart-checkout"
      className="rounded-lg border border-emerald-600/40 bg-emerald-950/30 p-4 text-emerald-100"
    >
      <h3 className="mb-2 text-base font-semibold">Checkout</h3>
      <p className="mb-3">Payment form would go here.</p>
      <FrameNavigateButton
        url="/cart/open"
        label="← back to cart"
        testId="cart-back-to-open"
      />
    </div>
  );
}

function CartFrameContent() {
  if (getPathname("/cart/closed")) return <CartClosedView />;
  if (getPathname("/cart/open")) return <CartOpenView />;
  if (getPathname("/cart/checkout")) return <CartCheckoutView />;
  return <div data-testid="cart-unknown">Unknown cart URL.</div>;
}

// ── Menu frame content ─────────────────────────────────────────────

function MenuClosedView() {
  return (
    <div
      data-testid="menu-closed"
      className="flex flex-wrap items-center gap-2 text-muted-foreground"
    >
      <span>Menu is closed.</span>
      <FrameNavigateButton
        url="/menu/about"
        label="About"
        testId="menu-about-btn"
      />
      <FrameNavigateButton
        url="/menu/settings"
        label="Settings"
        testId="menu-settings-btn"
      />
      <FrameNavigateButton
        url="/menu/slow"
        label="Slow (streaming)"
        testId="menu-slow-btn"
      />
    </div>
  );
}

function MenuAboutView() {
  return (
    <div
      data-testid="menu-about"
      className="rounded-lg border bg-card p-4 text-card-foreground"
    >
      <h3 className="mb-2 text-base font-semibold">About</h3>
      <p className="mb-3">
        Demo of the Frame primitive — two server-iframes on a normal page.
      </p>
      <FrameNavigateButton
        url="/menu/closed"
        label="Close"
        testId="menu-close-btn"
      />
    </div>
  );
}

function MenuSettingsView() {
  return (
    <div
      data-testid="menu-settings"
      className="rounded-lg border bg-card p-4 text-card-foreground"
    >
      <h3 className="mb-2 text-base font-semibold">Settings</h3>
      <p className="mb-3">(no settings yet)</p>
      <FrameNavigateButton
        url="/menu/closed"
        label="Close"
        testId="menu-close-from-settings"
      />
    </div>
  );
}

function MenuFrameContent() {
  if (getPathname("/menu/closed")) return <MenuClosedView />;
  if (getPathname("/menu/about")) return <MenuAboutView />;
  if (getPathname("/menu/settings")) return <MenuSettingsView />;
  if (getPathname("/menu/slow")) return <MenuSlowView />;
  return <div data-testid="menu-unknown">Unknown menu URL.</div>;
}

/**
 * Menu view that includes a slow async component behind a Suspense
 * boundary. Used to verify that streaming INSIDE a framed Partial
 * works — the fallback is painted first, then the delayed content
 * replaces it as the frame's Flight chunk arrives.
 */
async function SlowInsideFrame() {
  await new Promise((r) => setTimeout(r, 400));
  return (
    <div data-testid="menu-slow-content" className="p-2 text-emerald-400">
      Slow content loaded at {new Date().toLocaleTimeString()}
    </div>
  );
}

function MenuSlowView() {
  const parent = capturePartialContext();
  return (
    <div
      data-testid="menu-slow"
      className="rounded-lg border bg-card p-4 text-card-foreground"
    >
      <h3 className="mb-2 text-base font-semibold">
        Slow menu view (streaming)
      </h3>
      <Partial
        parent={parent}
        selector="#menu-slow-inner"
        fallback={
          <div data-testid="menu-slow-fallback" className="text-muted-foreground">
            Loading slow content…
          </div>
        }
      >
        <SlowInsideFrame />
      </Partial>
      <div className="mt-3">
        <FrameNavigateButton
          url="/menu/closed"
          label="Close"
          testId="menu-close-from-slow"
        />
      </div>
    </div>
  );
}

// ── Page ────────────────────────────────────────────────────────────

export function FramesDemoPage() {
  return (
    <main className="py-4">
      <title>Frames Demo</title>
      <h1 className="mb-4 text-2xl font-semibold">Frames demo</h1>
      <p className="mb-6 text-muted-foreground">
        The main listing is plain page content — product clicks update
        the window URL via{" "}
        <code className="rounded bg-muted px-1.5 py-0.5 text-[0.85em] font-mono">
          useNavigation()
        </code>
        , and the browser back/forward buttons handle navigation
        natively. Two frames (cart and menu) live alongside with their
        own URL scopes and inline nav bars.
      </p>

      <Card className="mb-4 p-5">
        <CardHeader className="px-0">
          <CardTitle className="text-base">
            Main listing (page-scoped)
          </CardTitle>
        </CardHeader>
        <CardContent className="px-0">
          <MainContent />
        </CardContent>
      </Card>

      <Card className="mb-4 p-5">
        <CardHeader className="px-0">
          <CardTitle className="text-base">Cart frame</CardTitle>
        </CardHeader>
        <CardContent className="px-0">
          <Partial
            parent={ROOT}
            selector="#cart"
            frame="cart"
            frameUrl="/cart/closed"
          >
            <FrameNavigationBar />
            <CartFrameContent />
          </Partial>
        </CardContent>
      </Card>

      <Card className="mb-4 p-5">
        <CardHeader className="px-0">
          <CardTitle className="text-base">Menu frame</CardTitle>
        </CardHeader>
        <CardContent className="px-0">
          <Partial
            parent={ROOT}
            selector="#menu"
            frame="menu"
            frameUrl="/menu/closed"
          >
            <FrameNavigationBar />
            <MenuFrameContent />
          </Partial>
        </CardContent>
      </Card>
    </main>
  );
}
