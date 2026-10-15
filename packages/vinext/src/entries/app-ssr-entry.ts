import { resolveRuntimeEntryModule } from "./runtime-entry-module.js";

/**
 * Generate the virtual SSR entry module.
 *
 * This runs in the `ssr` Vite environment. It receives an RSC stream,
 * deserializes it to a React tree, and renders to HTML.
 *
 * When `hasPagesDir` is true (hybrid App + Pages Router project), the SSR
 * entry also re-exports selected Pages server entry hooks from
 * `virtual:vinext-server-entry` so the RSC bundle can access Pages Router
 * route metadata and fallback dispatchers via `import("./ssr/index.js")`.
 */
export function generateSsrEntry(
  hasPagesDir = false,
  nitroPublicFilesPrefix: string | null = null,
): string {
  const entryPath = resolveRuntimeEntryModule("app-ssr-entry");
  // Nitro dispatches requests to this entry's fetch handler. When public/
  // files are routed through vinext, it also serves the file the router
  // resolves (see build/nitro-public-files.ts).
  const defaultExport = nitroPublicFilesPrefix
    ? `import __vinextSsrEntry from ${JSON.stringify(entryPath)};
import { withNitroPublicFiles } from ${JSON.stringify(resolveRuntimeEntryModule("nitro-public-files"))};
export default withNitroPublicFiles(__vinextSsrEntry, ${JSON.stringify(nitroPublicFilesPrefix)});`
    : `export { default } from ${JSON.stringify(entryPath)};`;

  return `
export * from ${JSON.stringify(entryPath)};
${defaultExport}
${
  hasPagesDir
    ? `
export {
  __ensureInstrumentation,
  handleApiRoute,
  matchApiRoute,
  matchPageRoute,
  pageRoutes,
  renderPage,
} from "virtual:vinext-server-entry";
`
    : ""
}`;
}
