/**
 * Page-level hero — large title + subhead at the top of /cms-demo.
 *
 * Distinct from the slot-level `HeroBlock` (`./hero.tsx`) which is a
 * smaller card used inside the composed slot. This one is the
 * page's "above the fold" header.
 */
import { getEnum, getText } from "../../framework/context.ts"
import { Card, CardContent } from "@/components/ui/card"
import { cn } from "@/lib/utils"

export function PageHeroBlock() {
  const headline = getText("headline")
  const subhead = getText("subhead")
  const tone = getEnum("tone", ["calm", "loud"] as const)
  return (
    <Card
      className={cn(
        "mb-4 p-6",
        tone === "loud" && "border-amber-400/60 bg-amber-500/5 dark:bg-amber-400/10",
      )}
      data-testid="cms-demo-hero"
    >
      <CardContent className="px-0">
        <h1 className="text-2xl font-semibold" data-testid="cms-demo-hero-headline">
          {headline}
        </h1>
        <p className="mt-2 text-muted-foreground">{subhead}</p>
      </CardContent>
    </Card>
  )
}
