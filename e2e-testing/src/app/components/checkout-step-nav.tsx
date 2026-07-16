"use client"

import { useNavigation } from "@parton/framework/client"
import { Button } from "@parton/copies/components/ui/button"

/**
 * Buttons that navigate the enclosing "checkout" frame to a
 * different `?step=` value. Each click changes the frame URL via
 * `useNavigation("checkout").navigate(...)`. The frame URL
 * doesn't affect the page URL — browser back/forward operates on
 * the window axis, the checkout frame has its own history.
 *
 * The frame URL drives a wrapper parton's `vary`, which threads
 * the new `step` into the `<RemoteFrame url=…?step=…>` URL.
 * That re-fetches the cross-origin remote with the new state.
 */
export function CheckoutStepNav() {
  const [navigate] = useNavigation("checkout").navigate()
  const steps = [
    { id: "shipping", label: "1 · Shipping" },
    { id: "payment", label: "2 · Payment" },
    { id: "review", label: "3 · Review" },
  ] as const

  return (
    <div className="mb-2 flex flex-wrap gap-2" data-testid="checkout-step-nav">
      {steps.map((s) => (
        <Button
          key={s.id}
          type="button"
          size="sm"
          variant="outline"
          data-testid={`checkout-step-${s.id}`}
          onClick={() => {
            void navigate(`/?step=${s.id}`)
          }}
        >
          {s.label}
        </Button>
      ))}
    </div>
  )
}
