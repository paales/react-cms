/**
 * Per-slug greeting card for the /cms-demo page. Reads its content
 * via the standard CMS accessor surface — match clauses on its
 * `cmsId` resolve against the request URL, so the same component
 * renders different content on /cms-demo/alpha vs /cms-demo/beta.
 */
import { getBoolean, getEnum, getNumber, getText } from "../../framework/context.ts"
import { Card, CardContent } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"

export function PageGreetingBlock() {
  const headline = getText("headline")
  const body = getText("body")
  const tone = getEnum("tone", ["calm", "loud"] as const)
  const accent = getNumber("accent")
  const emphasize = getBoolean("emphasize")
  return (
    <Card
      className={cn(
        "mb-4 p-6",
        tone === "loud" && "border-emerald-400/60 bg-emerald-500/5 dark:bg-emerald-400/10",
      )}
      data-testid="cms-demo-greeting"
    >
      <CardContent className="px-0">
        <div className="flex items-center gap-3">
          <h2
            className={cn("text-xl font-semibold", emphasize && "uppercase tracking-wide")}
            data-testid="cms-demo-greeting-headline"
          >
            {headline}
          </h2>
          {accent > 0 && (
            <Badge variant="secondary" data-testid="cms-demo-greeting-accent">
              accent {accent}
            </Badge>
          )}
        </div>
        <p className="mt-2 text-muted-foreground" data-testid="cms-demo-greeting-body">
          {body}
        </p>
      </CardContent>
    </Card>
  )
}
