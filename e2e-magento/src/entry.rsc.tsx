import { createRscHandler } from "@parton/framework/entry/rsc.tsx"
import { NotFoundPage } from "./app/pages/not-found.tsx"
import { Root } from "./app/root.tsx"

export default createRscHandler({
  Root,
  notFound: NotFoundPage,
  remote: {
    name: "magento",
    typesPath: new URL("./app/remote-types.ts", import.meta.url).pathname,
  },
})

if (import.meta.hot) {
  import.meta.hot.accept()
}
