import { ReactCms, type RenderArgs } from "@react-cms/framework"
import { Card, CardContent } from "@react-cms/copies/components/ui/card"
import { cn } from "@react-cms/copies/lib/utils"

export const PageHeroBlock = ReactCms.partial(
  function PageHeroRender({
    headline,
    subhead,
    tone,
  }: { headline: string; subhead: string; tone: "calm" | "loud" } & RenderArgs) {
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
  },
  {
    type: "page-hero",
    tags: [".page-block"],
    vary: ({ cms }) => ({
      headline: cms.text("headline"),
      subhead: cms.text("subhead"),
      tone: cms.enum("tone", ["calm", "loud"] as const),
    }),
  },
)
