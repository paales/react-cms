/**
 * Demo hero block — renders a headline + subhead + tone-driven
 * styling. Fields come from the block's own CMS node (set by the
 * enclosing `<Partial cmsId>` that the slot wrapper creates).
 */
import { getEnum, getText } from "../../framework/context.ts";
import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";

export function HeroBlock() {
  const headline = getText("headline");
  const subhead = getText("subhead");
  const tone = getEnum("tone", ["calm", "loud"] as const);
  return (
    <Card
      className={cn(
        "mb-3 p-5",
        tone === "loud" &&
          "border-amber-400/60 bg-amber-500/5 dark:bg-amber-400/10",
      )}
      data-testid="composed-hero"
    >
      <CardContent className="px-0">
        <h3
          className="text-base font-semibold"
          data-testid="composed-hero-headline"
        >
          {headline || "Untitled hero"}
        </h3>
        {subhead && (
          <p
            className="mt-1 text-sm text-muted-foreground"
            data-testid="composed-hero-subhead"
          >
            {subhead}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
