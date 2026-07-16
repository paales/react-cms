/**
 * /frames-demo — two server-iframes (`cart`, `menu`) with their own
 * URL scopes plus a window-scoped main listing. Each frame can host
 * a nested frame (`cart.tab`, `menu.tab`).
 */

import { parton, match, searchParam, type RenderArgs } from "@parton/framework"
import { Frame } from "@parton/framework"
import { FrameNavigateButton, UpdateEntryStateButton } from "../components/frames-demo-controls.tsx"
import { Card, CardContent, CardHeader, CardTitle } from "@parton/copies/components/ui/card"

// ─── Main listing (page-scoped) ─────────────────────────────────────────

export const FramesMainListPartial = parton(function FramesMainListRender() {
  const sku = searchParam("product")
  if (sku) {
    const renderedAt = Date.now()
    return (
      <div data-testid="main-detail" data-sku={sku} data-rendered-at={renderedAt}>
        <h3 className="mb-2 text-base font-semibold">Product: {sku}</h3>
        <p className="mb-3 text-muted-foreground">Window URL: ?product={sku}</p>
        <FrameNavigateButton url="/frames-demo" label="← back to list" testId="main-back-to-list" />
      </div>
    )
  }
  const skus = ["alpha", "beta", "gamma"]
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
  )
})

// ─── Cart tab content (nested frame) ────────────────────────────────────

export const CartTabPartial = parton(function CartTabRender() {
  // Frame-scoped: `match()` reads this parton's frame-resolved URL and
  // folds only the captured `:tab` segment.
  const { tab } = match("/:tab") ?? {}
  return (
    <div data-testid="cart-tab">
      <div className="mb-2 flex flex-wrap gap-2">
        <FrameNavigateButton url="/items" label="Items" testId="cart-tab-items" />
        <FrameNavigateButton url="/coupons" label="Coupons" testId="cart-tab-coupons" />
        <FrameNavigateButton url="/summary" label="Summary" testId="cart-tab-summary" />
      </div>
      {tab === "items" && (
        <div data-testid="cart-tab-items-body" className="rounded-md border border-dashed p-3">
          3 items in your cart. Fresh render @ {new Date().toLocaleTimeString()}
        </div>
      )}
      {tab === "coupons" && (
        <div data-testid="cart-tab-coupons-body" className="rounded-md border border-dashed p-3">
          Apply coupon — none active. Fresh render @ {new Date().toLocaleTimeString()}
        </div>
      )}
      {tab === "summary" && (
        <div data-testid="cart-tab-summary-body" className="rounded-md border border-dashed p-3">
          Subtotal $0.00 · tax $0.00. Fresh render @ {new Date().toLocaleTimeString()}
        </div>
      )}
    </div>
  )
})

// ─── Cart frame content ────────────────────────────────────────────────

function NestedFrameShell({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="rounded-lg border-l-2 border-sky-500/50 bg-muted/20 p-3">
      <div className="mb-2 text-xs font-semibold uppercase tracking-wider text-sky-400">
        nested frame · {label}
      </div>
      {children}
    </div>
  )
}

export const CartFramePartial = parton(function CartFrameRender() {
  const state = (match("/cart/:state")?.state ?? "unknown") as
    | "closed"
    | "open"
    | "checkout"
    | "unknown"
  switch (state) {
    case "closed":
      return (
        <div
          data-testid="cart-closed"
          className="flex flex-wrap items-center gap-2 text-muted-foreground"
        >
          <span>Cart is closed.</span>
          <FrameNavigateButton url="/cart/open" label="Open cart" testId="cart-open-btn" />
        </div>
      )
    case "open":
      return (
        <div data-testid="cart-open" className="rounded-lg border bg-card p-4">
          <h3 className="mb-2 text-base font-semibold">Cart</h3>
          <p className="mb-3 text-muted-foreground">
            0 items · rendered at {new Date().toLocaleTimeString()}
          </p>
          <div className="mb-4 flex flex-wrap gap-2">
            <FrameNavigateButton
              url="/cart/checkout"
              label="Go to checkout"
              testId="cart-checkout-btn"
            />
            <FrameNavigateButton url="/cart/closed" label="Close" testId="cart-close-btn" />
            <UpdateEntryStateButton
              patch={{ itemsReady: true }}
              label="Mark ready"
              testId="cart-mark-ready"
            />
          </div>
          <NestedFrameShell label="cart.tab">
            <Frame name="tab" initialUrl="/items">
              <CartTabPartial />
            </Frame>
          </NestedFrameShell>
        </div>
      )
    case "checkout":
      return (
        <div
          data-testid="cart-checkout"
          className="rounded-lg border border-emerald-600/40 bg-emerald-950/30 p-4"
        >
          <h3 className="mb-2 text-base font-semibold">Checkout</h3>
          <p className="mb-3">Payment form would go here.</p>
          <FrameNavigateButton url="/cart/open" label="← back to cart" testId="cart-back-to-open" />
        </div>
      )
    default:
      return <div data-testid="cart-unknown">Unknown cart URL.</div>
  }
})

// ─── Menu tab + slow ────────────────────────────────────────────────────

export const MenuTabPartial = parton(function MenuTabRender() {
  const { tab } = match("/:tab") ?? {}
  return (
    <div data-testid="menu-tab">
      <div className="mb-2 flex flex-wrap gap-2">
        <FrameNavigateButton url="/general" label="General" testId="menu-tab-general" />
        <FrameNavigateButton url="/advanced" label="Advanced" testId="menu-tab-advanced" />
      </div>
      {tab === "general" && (
        <div data-testid="menu-tab-general-body" className="rounded-md border border-dashed p-3">
          General preferences. Fresh render @ {new Date().toLocaleTimeString()}
        </div>
      )}
      {tab === "advanced" && (
        <div data-testid="menu-tab-advanced-body" className="rounded-md border border-dashed p-3">
          Advanced knobs. Fresh render @ {new Date().toLocaleTimeString()}
        </div>
      )}
    </div>
  )
})

export const MenuSlowInnerPartial = parton(
  async function MenuSlowInnerRender({}: RenderArgs) {
    await new Promise((r) => setTimeout(r, 400))
    return (
      <div data-testid="menu-slow-content" className="p-2 text-emerald-400">
        Slow content loaded at {new Date().toLocaleTimeString()}
      </div>
    )
  },
  {
    fallback: (
      <div data-testid="menu-slow-fallback" className="text-muted-foreground">
        Loading slow content…
      </div>
    ),
  },
)

export const MenuFramePartial = parton(function MenuFrameRender() {
  const state = (match("/menu/:state")?.state ?? "unknown") as
    | "closed"
    | "about"
    | "settings"
    | "slow"
    | "unknown"
  switch (state) {
    case "closed":
      return (
        <div
          data-testid="menu-closed"
          className="flex flex-wrap items-center gap-2 text-muted-foreground"
        >
          <span>Menu is closed.</span>
          <FrameNavigateButton url="/menu/about" label="About" testId="menu-about-btn" />
          <FrameNavigateButton url="/menu/settings" label="Settings" testId="menu-settings-btn" />
          <FrameNavigateButton url="/menu/slow" label="Slow (streaming)" testId="menu-slow-btn" />
        </div>
      )
    case "about":
      return (
        <div data-testid="menu-about" className="rounded-lg border bg-card p-4">
          <h3 className="mb-2 text-base font-semibold">About</h3>
          <p className="mb-3">Demo of the Frame primitive.</p>
          <FrameNavigateButton url="/menu/closed" label="Close" testId="menu-close-btn" />
          <NestedFrameShell label="menu.tab">
            <Frame name="tab" initialUrl="/general">
              <MenuTabPartial />
            </Frame>
          </NestedFrameShell>
        </div>
      )
    case "settings":
      return (
        <div data-testid="menu-settings" className="rounded-lg border bg-card p-4">
          <h3 className="mb-2 text-base font-semibold">Settings</h3>
          <p className="mb-3">(no settings yet)</p>
          <FrameNavigateButton url="/menu/closed" label="Close" testId="menu-close-from-settings" />
        </div>
      )
    case "slow":
      return (
        <div data-testid="menu-slow" className="rounded-lg border bg-card p-4">
          <h3 className="mb-2 text-base font-semibold">Slow menu view (streaming)</h3>
          <MenuSlowInnerPartial />
          <div className="mt-3">
            <FrameNavigateButton url="/menu/closed" label="Close" testId="menu-close-from-slow" />
          </div>
        </div>
      )
    default:
      return <div data-testid="menu-unknown">Unknown menu URL.</div>
  }
})

// ─── Chrome ─────────────────────────────────────────────────────────────

export const FramesDemoPage = parton(
  function FramesDemoRender() {
    return (
      <main className="py-4">
        <title>Frames Demo</title>
        <h1 className="mb-4 text-2xl font-semibold">Frames demo</h1>
        <Card className="mb-4 p-5">
          <CardHeader className="px-0">
            <CardTitle className="text-base">Main listing (page-scoped)</CardTitle>
          </CardHeader>
          <CardContent className="px-0">
            <FramesMainListPartial />
          </CardContent>
        </Card>
        <Card className="mb-4 p-5">
          <CardHeader className="px-0">
            <CardTitle className="text-base">Cart frame</CardTitle>
          </CardHeader>
          <CardContent className="px-0">
            <Frame name="cart" initialUrl="/cart/closed">
              <CartFramePartial />
            </Frame>
          </CardContent>
        </Card>
        <Card className="mb-4 p-5">
          <CardHeader className="px-0">
            <CardTitle className="text-base">Menu frame</CardTitle>
          </CardHeader>
          <CardContent className="px-0">
            <Frame name="menu" initialUrl="/menu/closed">
              <MenuFramePartial />
            </Frame>
          </CardContent>
        </Card>
      </main>
    )
  },
  { match: "/frames-demo" },
)
