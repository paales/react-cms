/**
 * CMS demo — chunk 1 end-to-end proof.
 *
 * Two CMS-aware Partials on one page:
 *
 *   - `#hero` (cmsId="cms-demo-hero") has no request-input dimensions
 *     in its store entry, so every visitor sees the same content.
 *     Global configuration.
 *
 *   - `#greeting` (cmsId="cms-demo-greeting") has per-slug configs
 *     keyed on `pathname:/cms-demo/:slug`. Visit `/cms-demo/alpha`,
 *     `/cms-demo/beta`, `/cms-demo/gamma`, or `/cms-demo/zulu` to see
 *     cascade resolution pick different fields. The `alpha` config is
 *     an exact match; `beta` / `gamma` share a config via `{in: [...]}`;
 *     `zulu` (and `/cms-demo` with no slug) fall through to the default.
 *
 * None of these field values are in code — edit `src/cms/content.json`
 * and reload. Authoring for this chunk is "hand-edit the JSON"; the
 * visual editor comes in a future chunk.
 *
 * See `notes/CMS_VISION.md` / `notes/CMS_MANIFEST.md` / `notes/CMS_EDITOR.md`.
 */

import {
  getBoolean,
  getEnum,
  getNumber,
  getText,
} from "../../framework/context.ts";
import { Children, Partial } from "../../lib";
import { ROOT } from "../../lib/partial-context.ts";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";

const SLUG_LINKS: ReadonlyArray<[href: string, label: string]> = [
  ["/cms-demo", "Default (no slug)"],
  ["/cms-demo/alpha", "alpha"],
  ["/cms-demo/beta", "beta"],
  ["/cms-demo/gamma", "gamma"],
  ["/cms-demo/zulu", "zulu (unmatched)"],
];

export function CmsDemoPage() {
  return (
    <>
      <Partial parent={ROOT} selector="#cms-demo-hero" cmsId="cms-demo-hero">
        <HeroBlock />
      </Partial>

      <nav
        className="mb-6 flex flex-wrap gap-1"
        aria-label="CMS demo slugs"
      >
        {SLUG_LINKS.map(([href, label]) => (
          <a
            key={href}
            href={href}
            className={buttonVariants({ variant: "ghost", size: "sm" })}
          >
            {label}
          </a>
        ))}
      </nav>

      <Partial
        parent={ROOT}
        selector="#cms-demo-greeting"
        cmsId="cms-demo-greeting"
      >
        <GreetingBlock />
      </Partial>

      <h2 className="mt-8 mb-3 text-lg font-semibold">
        Composed from a slot
      </h2>
      <Partial
        parent={ROOT}
        selector="#cms-demo-composed"
        cmsId="cms-demo-composed"
      >
        <div data-testid="cms-demo-composed-slot">
          <Children name="body" allow=".demo-block" />
        </div>
      </Partial>

      <Card className="mt-8 p-5">
        <CardContent className="px-0 text-sm text-muted-foreground">
          <p className="mb-2 font-semibold text-foreground">
            What you're looking at
          </p>
          <ul className="list-disc space-y-1 pl-5">
            <li>
              Both blocks render content read from{" "}
              <code className="rounded bg-muted px-1.5 py-0.5 text-[0.85em] font-mono">
                src/cms/content.json
              </code>{" "}
              through accessor calls like{" "}
              <code className="rounded bg-muted px-1.5 py-0.5 text-[0.85em] font-mono">
                getText("headline")
              </code>
              . No component receives CMS data as props — the accessor
              reads the ambient CMS scope opened by{" "}
              <code className="rounded bg-muted px-1.5 py-0.5 text-[0.85em] font-mono">
                &lt;Partial cmsId=…&gt;
              </code>
              .
            </li>
            <li>
              Changing the URL segment changes the greeting Partial's
              resolved config. The resolver reads each config's{" "}
              <code className="rounded bg-muted px-1.5 py-0.5 text-[0.85em] font-mono">
                match
              </code>{" "}
              clause directly against the current request — no{" "}
              <code className="rounded bg-muted px-1.5 py-0.5 text-[0.85em] font-mono">
                getPathname
              </code>{" "}
              call needed inside the block itself.
            </li>
            <li>
              Edit the JSON and reload — mtime-based caching picks up
              the change on the next request.
            </li>
          </ul>
        </CardContent>
      </Card>
    </>
  );
}

function HeroBlock() {
  const headline = getText("headline");
  const subhead = getText("subhead");
  const tone = getEnum("tone", ["calm", "loud"] as const);
  return (
    <Card
      className={cn(
        "mb-4 p-6",
        tone === "loud" &&
          "border-amber-400/60 bg-amber-500/5 dark:bg-amber-400/10",
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
  );
}

function GreetingBlock() {
  const headline = getText("headline");
  const body = getText("body");
  const tone = getEnum("tone", ["calm", "loud"] as const);
  const accent = getNumber("accent");
  const emphasize = getBoolean("emphasize");
  return (
    <Card
      className={cn(
        "mb-4 p-6",
        tone === "loud" &&
          "border-emerald-400/60 bg-emerald-500/5 dark:bg-emerald-400/10",
      )}
      data-testid="cms-demo-greeting"
    >
      <CardContent className="px-0">
        <div className="flex items-center gap-3">
          <h2
            className={cn(
              "text-xl font-semibold",
              emphasize && "uppercase tracking-wide",
            )}
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
        <p
          className="mt-2 text-muted-foreground"
          data-testid="cms-demo-greeting-body"
        >
          {body}
        </p>
      </CardContent>
    </Card>
  );
}
