import { createRscHandler } from "@parton/framework/entry/rsc.tsx"
import { Root } from "./app/root.tsx"

export type { RscPayload } from "@parton/framework/entry/rsc.tsx"

export default createRscHandler({ Root })
