/**
 * /frames-demo — two server-iframes (`cart`, `menu`) with their own
 * URL scopes plus a window-scoped main listing. Each frame can host
 * a nested frame (`cart.tab`, `menu.tab`).
 */

import { ReactCms, type RenderArgs } from "@react-cms/framework"
import { FrameNavigateButton, UpdateEntryStateButton } from "../components/frames-demo-controls.tsx"
import { Card, CardContent, CardHeader, CardTitle } from "@react-cms/copies/components/ui/card"

// ─── Main listing (page-scoped) ─────────────────────────────────────────

export const FramesMainListPartial = ReactCms.partial(
  function FramesMainListRender({
    sku,
  }: {
    sku: string | null
  } & RenderArgs) {
    if (sku) {
      const renderedAt = Date.now()
      return (
        <div data-testid="main-detail" data-sku={sku} data-rendered-at={renderedAt}>
          <h3 className="mb-2 text-base font-semibold">Product: {sku}</h3>
          <p className="mb-3 text-muted-foreground">Window URL: ?product={sku}</p>
          <FrameNavigateButton
            url="/frames-demo"
            label="← back to list"
            testId="main-back-to-list"
          />
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
  },
  {
    selector: "#frames-main-list",
    vary: ({ search: { product: sku = null } }) => ({ sku }),
  },
)

// ─── Cart tab content (nested frame) ────────────────────────────────────

export const CartTabPartial = ReactCms.partial(
  function CartTabRender({
    pathname,
  }: {
    pathname: string
  } & RenderArgs) {
    return (
      <div data-testid="cart-tab">
        <div className="mb-2 flex flex-wrap gap-2">
          <FrameNavigateButton url="/items" label="Items" testId="cart-tab-items" />
          <FrameNavigateButton url="/coupons" label="Coupons" testId="cart-tab-coupons" />
          <FrameNavigateButton url="/summary" label="Summary" testId="cart-tab-summary" />
        </div>
        {pathname === "/items" && (
          <div data-testid="cart-tab-items-body" className="rounded-md border border-dashed p-3">
            3 items in your cart. Fresh render @ {new Date().toLocaleTimeString()}
          </div>
        )}
        {pathname === "/coupons" && (
          <div data-testid="cart-tab-coupons-body" className="rounded-md border border-dashed p-3">
            Apply coupon — none active. Fresh render @ {new Date().toLocaleTimeString()}
          </div>
        )}
        {pathname === "/summary" && (
          <div data-testid="cart-tab-summary-body" className="rounded-md border border-dashed p-3">
            Subtotal $0.00 · tax $0.00. Fresh render @ {new Date().toLocaleTimeString()}
          </div>
        )}
      </div>
    )
  },
  {
    selector: "#cart-tab",
    frame: "tab",
    frameUrl: "/items",
    vary: ({ pathname }) => ({ pathname }),
  },
)

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

export const CartFramePartial = ReactCms.partial(
  function CartFrameRender({
    state,
    parent,
  }: {
    state: "closed" | "open" | "checkout" | "unknown"
  } & RenderArgs) {
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
              <CartTabPartial parent={parent} />
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
            <FrameNavigateButton
              url="/cart/open"
              label="← back to cart"
              testId="cart-back-to-open"
            />
          </div>
        )
      default:
        return <div data-testid="cart-unknown">Unknown cart URL.</div>
    }
  },
  {
    selector: "#cart",
    frame: "cart",
    frameUrl: "/cart/closed",
    vary: ({ pathname: pn }) => {
      const state: "closed" | "open" | "checkout" | "unknown" =
        pn === "/cart/closed"
          ? "closed"
          : pn === "/cart/open"
            ? "open"
            : pn === "/cart/checkout"
              ? "checkout"
              : "unknown"
      return { state }
    },
  },
)

// ─── Menu tab + slow ────────────────────────────────────────────────────

export const MenuTabPartial = ReactCms.partial(
  function MenuTabRender({
    pathname,
  }: {
    pathname: string
  } & RenderArgs) {
    return (
      <div data-testid="menu-tab">
        <div className="mb-2 flex flex-wrap gap-2">
          <FrameNavigateButton url="/general" label="General" testId="menu-tab-general" />
          <FrameNavigateButton url="/advanced" label="Advanced" testId="menu-tab-advanced" />
        </div>
        {pathname === "/general" && (
          <div data-testid="menu-tab-general-body" className="rounded-md border border-dashed p-3">
            General preferences. Fresh render @ {new Date().toLocaleTimeString()}
          </div>
        )}
        {pathname === "/advanced" && (
          <div data-testid="menu-tab-advanced-body" className="rounded-md border border-dashed p-3">
            Advanced knobs. Fresh render @ {new Date().toLocaleTimeString()}
          </div>
        )}
      </div>
    )
  },
  {
    selector: "#menu-tab",
    frame: "tab",
    frameUrl: "/general",
    vary: ({ pathname }) => ({ pathname }),
  },
)

export const MenuSlowInnerPartial = ReactCms.partial(
  async function MenuSlowInnerRender({}: RenderArgs) {
    await new Promise((r) => setTimeout(r, 400))
    return (
      <div data-testid="menu-slow-content" className="p-2 text-emerald-400">
        Slow content loaded at {new Date().toLocaleTimeString()}
      </div>
    )
  },
  {
    selector: "#menu-slow-inner",
    fallback: (
      <div data-testid="menu-slow-fallback" className="text-muted-foreground">
        Loading slow content…
      </div>
    ),
  },
)

export const MenuFramePartial = ReactCms.partial(
  function MenuFrameRender({
    state,
    parent,
  }: {
    state: "closed" | "about" | "settings" | "slow" | "unknown"
  } & RenderArgs) {
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
            <FrameNavigateButton
              url="/menu/slow"
              label="Slow (streaming)"
              testId="menu-slow-btn"
            />
          </div>
        )
      case "about":
        return (
          <div data-testid="menu-about" className="rounded-lg border bg-card p-4">
            <h3 className="mb-2 text-base font-semibold">About</h3>
            <p className="mb-3">Demo of the Frame primitive.</p>
            <FrameNavigateButton url="/menu/closed" label="Close" testId="menu-close-btn" />
            <NestedFrameShell label="menu.tab">
              <MenuTabPartial parent={parent} />
            </NestedFrameShell>
          </div>
        )
      case "settings":
        return (
          <div data-testid="menu-settings" className="rounded-lg border bg-card p-4">
            <h3 className="mb-2 text-base font-semibold">Settings</h3>
            <p className="mb-3">(no settings yet)</p>
            <FrameNavigateButton
              url="/menu/closed"
              label="Close"
              testId="menu-close-from-settings"
            />
          </div>
        )
      case "slow":
        return (
          <div data-testid="menu-slow" className="rounded-lg border bg-card p-4">
            <h3 className="mb-2 text-base font-semibold">Slow menu view (streaming)</h3>
            <MenuSlowInnerPartial parent={parent} />
            <div className="mt-3">
              <FrameNavigateButton
                url="/menu/closed"
                label="Close"
                testId="menu-close-from-slow"
              />
            </div>
          </div>
        )
      default:
        return <div data-testid="menu-unknown">Unknown menu URL.</div>
    }
  },
  {
    selector: "#menu",
    frame: "menu",
    frameUrl: "/menu/closed",
    vary: ({ pathname: pn }) => {
      const state: "closed" | "about" | "settings" | "slow" | "unknown" =
        pn === "/menu/closed"
          ? "closed"
          : pn === "/menu/about"
            ? "about"
            : pn === "/menu/settings"
              ? "settings"
              : pn === "/menu/slow"
                ? "slow"
                : "unknown"
      return { state }
    },
  },
)

// ─── Chrome ─────────────────────────────────────────────────────────────

export const FramesDemoPage = ReactCms.partial(
  function FramesDemoRender({ parent }: RenderArgs) {
    return (
      <main className="py-4">
        <title>Frames Demo</title>
        <h1 className="mb-4 text-2xl font-semibold">Frames demo</h1>
        <Card className="mb-4 p-5">
          <CardHeader className="px-0">
            <CardTitle className="text-base">Main listing (page-scoped)</CardTitle>
          </CardHeader>
          <CardContent className="px-0">
            <FramesMainListPartial parent={parent} />
          </CardContent>
        </Card>
        <Card className="mb-4 p-5">
          <CardHeader className="px-0">
            <CardTitle className="text-base">Cart frame</CardTitle>
          </CardHeader>
          <CardContent className="px-0">
            <CartFramePartial parent={parent} />
          </CardContent>
        </Card>
        <Card className="mb-4 p-5">
          <CardHeader className="px-0">
            <CardTitle className="text-base">Menu frame</CardTitle>
          </CardHeader>
          <CardContent className="px-0">
            <MenuFramePartial parent={parent} />
          </CardContent>
        </Card>
      </main>
    )
  },
  { match: "/frames-demo" },
)
