/**
 * Applies the parton "server context" patch to a copy of
 * `@vitejs/plugin-rsc`'s vendored react-server-dom Flight server.
 *
 * React's RSC renderer has no Server Component context, so we thread our
 * own value through its task graph (see `framework/src/lib/server-context.ts`):
 *
 *  - `createTask` inherits `partonContext` from the currently-rendering
 *    task (`request.__renderingTask`), exactly how it already inherits
 *    `formatContext`;
 *  - `retryTask` save/restores `request.__renderingTask` so it always
 *    names the task whose render is executing (and depth-first sibling
 *    renders don't clobber it);
 *  - the render site stamps that task onto
 *    `ReactSharedInternalsServer.__partonTask` so a component can read its
 *    parent + scope its children synchronously at its render top.
 *
 * Run via `yarn patch` (see docs/internals). `node this.mjs <pkgDir>` edits
 * the dev + prod edge builds in `<pkgDir>/dist/vendor/react-server-dom/cjs/`.
 * Each edit asserts a unique anchor match, so an upstream change fails
 * loudly instead of silently mis-patching.
 */

import { readFileSync, writeFileSync } from "node:fs"

const pkgDir = process.argv[2]
if (!pkgDir) throw new Error("usage: node patch-plugin-rsc-server-context.mjs <pkgDir>")
const cjs = `${pkgDir}/dist/vendor/react-server-dom/cjs/`

const INHERIT =
  "request.__renderingTask ? (request.__renderingTask.partonChildContext !== undefined ? request.__renderingTask.partonChildContext : request.__renderingTask.partonContext) : null"

function patch(file, edits) {
  let s = readFileSync(file, "utf8")
  for (const [needle, repl] of edits) {
    const n = s.split(needle).length - 1
    if (n !== 1) throw new Error(`${file}: expected 1 match, got ${n} for: ${needle.slice(0, 70)}…`)
    s = s.replace(needle, repl)
  }
  writeFileSync(file, s)
  console.log(`patched ${file.split("/").pop()}: ${edits.length} edits`)
}

// ── development build (8-space indent) ──
patch(cjs + "react-server-dom-webpack-server.edge.development.js", [
  [
    "    function retryTask(request, task) {\n      if (0 === task.status) {",
    "    function retryTask(request, task) {\n      var __prevRenderingTask = request.__renderingTask;\n      request.__renderingTask = task;\n      try {\n      if (0 === task.status) {",
  ],
  [
    "            (serializedSize = parentSerializedSize);\n        }\n      }\n    }",
    "            (serializedSize = parentSerializedSize);\n        }\n      }\n      } finally {\n        request.__renderingTask = __prevRenderingTask;\n      }\n    }",
  ],
  [
    "        formatContext: formatContext,\n        ping: function () {\n          return pingTask(request, task);\n        },",
    `        formatContext: formatContext,\n        partonContext: ${INHERIT},\n        partonChildContext: ${INHERIT},\n        ping: function () {\n          return pingTask(request, task);\n        },`,
  ],
  [
    "      currentComponentDebugInfo = componentDebugInfo;\n      props = supportsComponentStorage",
    "      currentComponentDebugInfo = componentDebugInfo;\n      ReactSharedInternalsServer.__partonTask = task;\n      props = supportsComponentStorage",
  ],
])

// ── production build (2/4-space indent) ──
patch(cjs + "react-server-dom-webpack-server.edge.production.js", [
  [
    "function retryTask(request, task) {\n  if (0 === task.status) {",
    "function retryTask(request, task) {\n  var __prevRenderingTask = request.__renderingTask;\n  request.__renderingTask = task;\n  try {\n  if (0 === task.status) {",
  ],
  [
    "      serializedSize = parentSerializedSize;\n    }\n  }\n}",
    "      serializedSize = parentSerializedSize;\n    }\n  }\n  } finally {\n    request.__renderingTask = __prevRenderingTask;\n  }\n}",
  ],
  [
    "    formatContext: formatContext,\n    ping: function () {\n      return pingTask(request, task);\n    },",
    `    formatContext: formatContext,\n    partonContext: ${INHERIT},\n    partonChildContext: ${INHERIT},\n    ping: function () {\n      return pingTask(request, task);\n    },`,
  ],
  [
    "  thenableState = prevThenableState;\n  props = Component(props, void 0);",
    "  thenableState = prevThenableState;\n  ReactSharedInternalsServer.__partonTask = task;\n  props = Component(props, void 0);",
  ],
])

console.log("server-context patch applied")
