import { Partial, capturePartialContext } from "../../lib";
import { buttonVariants } from "@/components/ui/button";

const LINKS: Array<[href: string, label: string]> = [
  ["/", "Pokemon"],
  ["/magento", "Magento Store"],
  ["/bare", "Bare Stream"],
  ["/cache-demo", "Cache Demo"],
  ["/defer-demo", "Defer Demo"],
  ["/selector-demo", "Selector Demo"],
  ["/sentinels-demo", "Sentinels Demo"],
  ["/frames-demo", "Frames Demo"],
  ["/cms-demo", "CMS Demo"],
  ["/cms-edit", "CMS Edit"],
];

/**
 * Shared cross-page nav. Self-contained — wraps its own content in
 * `<Partial selector="#nav">` so every page gets a fingerprint-skippable
 * nav just by rendering `<AppNav/>`.
 */
export function AppNav() {
  const parent = capturePartialContext();
  return (
    <Partial parent={parent} selector="#nav">
      <nav className="mb-6 flex flex-wrap gap-1 border-b pb-3">
        {LINKS.map(([href, label]) => (
          <a
            key={href}
            href={href}
            className={buttonVariants({ variant: "ghost", size: "sm" })}
          >
            {label}
          </a>
        ))}
      </nav>
    </Partial>
  );
}
