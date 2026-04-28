"use client"

/**
 * Fixture for rsc-project tests: a plain client component. When a
 * server tree imports this file, the plugin-rsc `"use client"`
 * transform should swap it for a client-reference proxy whose
 * `$$typeof` is `Symbol.for("react.client.reference")`. The server
 * renderer encodes that as a `$L<n>` lazy ref in the Flight stream.
 */
export function ClientButton({ label }: { label: string }) {
  return <button type="button">{label}</button>
}
