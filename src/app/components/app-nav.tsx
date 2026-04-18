/**
 * Shared cross-page nav. Wrap at each callsite with `<Partial id="nav">`
 * so the nav is fingerprint-skippable on route-internal refetches.
 *
 * We deliberately do NOT include `<Partial>` inside this component —
 * framework `buildTemplate` can only see Partials that are direct JSX
 * children of `<PartialRoot>`'s tree. Hiding a Partial behind an
 * opaque component would cause it to re-execute (template + children
 * paths) and trigger a duplicate-id error.
 */
export function AppNav() {
  return (
    <nav
      style={{
        marginBottom: "1.5rem",
        paddingBottom: "1rem",
        borderBottom: "1px solid #2d3748",
      }}
    >
      <a href="/">Pokemon</a>
      {" · "}
      <a href="/magento">Magento Store</a>
      {" · "}
      <a href="/bare">Bare Stream</a>
      {" · "}
      <a href="/cache-demo">Cache Demo</a>
      {" · "}
      <a href="/defer-demo">Defer Demo</a>
    </nav>
  );
}
