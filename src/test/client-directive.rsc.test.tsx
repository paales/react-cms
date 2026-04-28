import { describe, expect, it } from "vitest"
import { renderAndInspect } from "./rsc-server.ts"
import { ClientButton } from "./__fixtures__/client-button.tsx"

describe("use-client transform", () => {
  it("encodes a client component as a client reference in Flight", async () => {
    const { text } = await renderAndInspect<unknown>(
      <div>
        <ClientButton label="click me" />
      </div>,
    )

    // Plugin-rsc's transform replaces `ClientButton` with a proxy whose
    // `$$typeof` is `react.client.reference`. The server renderer
    // encodes that as an `$L<n>` pointer in chunk 0 and emits the
    // client module metadata (id + export name) as an import row.
    expect(text).toMatch(/client-button\.tsx/)
    expect(text).toContain("ClientButton")
    expect(text).toContain("click me")
    // Flight uses `"$L<n>"` for a pending lazy ref to the client module.
    expect(text).toMatch(/\$L\d+/)
  })
})
