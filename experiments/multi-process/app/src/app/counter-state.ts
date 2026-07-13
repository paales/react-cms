import { localCell } from "@parton/framework"

/** The one shared slot both backend processes read and write. No
 *  `partition` — every viewer and every writer hits the same `{}`
 *  partition of the shared SQLite store. */
export const counter = localCell({
  id: "mp.counter",
  shape: "number",
  initial: 0,
})
