import { createRscHandler } from "@parton/framework/entry/rsc.tsx"
import { _clearLogs } from "./app/chat/log.ts"
import { serveDocAsset } from "./app/pages/docs-fs.ts"
import { NotFoundPage } from "./app/pages/not-found.tsx"
import { Root } from "./app/root.tsx"

export default createRscHandler({
  Root,
  notFound: NotFoundPage,
  // Image subresources under /docs/ (direct links + screenshots
  // embedded in markdown) are served as raw bytes; HTML doc pages fall
  // through to the normal RSC/SSR pipeline.
  fetch: serveDocAsset,
  remote: { name: "e2e-testing" },
  clearCaches: _clearLogs,
})

if (import.meta.hot) {
  import.meta.hot.accept()
}
