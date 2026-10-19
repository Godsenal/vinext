import path from "pathslash";
import type { Plugin } from "vite";

const CLIENT_GUARD_ID = "\0vinext:client-config-source-guard";
const GUARD_PATH = path.resolve(import.meta.dirname, "../config/config-source-guard");

/**
 * Keeps the ReDoS analyzer out of client builds.
 *
 * config-matchers checks next.config.js sources and condition regexes
 * through config/config-source-guard. In the browser it only matches the
 * redirects and rewrites the server published, after leaving out rules with a
 * skipped source or a condition value rejected as unsafe, and escaping
 * condition values that are not valid regexes (toClientRedirects,
 * toClientRewrites), so the client build gets a guard that accepts every
 * pattern. Server environments keep the real one.
 */
export const clientConfigSourceGuardPlugin: Plugin = {
  name: "vinext:client-config-source-guard",
  enforce: "pre",

  resolveId: {
    filter: { id: /(?:^|\/)config-source-guard(?:\.[cm]?[jt]s)?$/ },
    handler(id, importer) {
      if (this.environment?.config.consumer !== "client" || !importer) return;
      const resolved = path.resolve(path.dirname(importer.split("?")[0]!), id);
      if (resolved.replace(/\.[cm]?[jt]s$/, "") !== GUARD_PATH) return;
      return CLIENT_GUARD_ID;
    },
  },

  load: {
    filter: { id: new RegExp(`^${CLIENT_GUARD_ID}$`) },
    handler(id) {
      if (id !== CLIENT_GUARD_ID) return;
      return [
        "export function unsafeConfigSourceReason() { return null; }",
        "export function isSafeConfigRegex() { return true; }",
      ].join("\n");
    },
  },
};
