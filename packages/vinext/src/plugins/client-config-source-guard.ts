import path from "pathslash";
import type { Plugin } from "vite";

const CLIENT_GUARD_ID = "\0vinext:client-config-source-guard";
const CLIENT_RULES_QUERY = "?vinext-client-rules";
const PACKAGE_DIR = path.resolve(import.meta.dirname, "..");
const MATCHERS_PATH = path.join(PACKAGE_DIR, "config/config-matchers");
const MATCHERS_FILE = MATCHERS_PATH + path.extname(import.meta.filename);
const GUARD_PATH = path.join(PACKAGE_DIR, "config/config-source-guard");

function withoutExtension(file: string): string {
  return file.replace(/\.[cm]?[jt]s$/, "");
}

/**
 * Keeps the ReDoS analyzer out of client builds.
 *
 * config-matchers checks next.config.js sources and condition regexes
 * through config/config-source-guard. vinext's own client modules only match
 * the redirects and rewrites the server published, after leaving out rules
 * with a skipped source or a condition value rejected as unsafe, and escaping
 * condition values that are not valid regexes (toClientRedirects,
 * toClientRewrites). So in client environments their config-matchers imports
 * resolve to a separate copy whose guard accepts every pattern. Other
 * importers, such as app code using the public `vinext/config/config-matchers`
 * export, and server environments keep the real guard.
 */
export const clientConfigSourceGuardPlugin: Plugin = {
  name: "vinext:client-config-source-guard",
  enforce: "pre",

  resolveId: {
    filter: { id: /(?:^|\/)config-(?:matchers|source-guard)(?:\.[cm]?[jt]s)?$/ },
    handler(id, importer) {
      if (this.environment?.config.consumer !== "client" || !importer) return;
      const [importerPath, query = ""] = importer.split("?");
      if (!id.startsWith(".") && !path.isAbsolute(id)) return;
      const resolved = withoutExtension(path.resolve(path.dirname(importerPath!), id));
      if (resolved === MATCHERS_PATH && importerPath!.startsWith(`${PACKAGE_DIR}/`)) {
        return MATCHERS_FILE + CLIENT_RULES_QUERY;
      }
      if (
        resolved === GUARD_PATH &&
        withoutExtension(importerPath!) === MATCHERS_PATH &&
        `?${query}` === CLIENT_RULES_QUERY
      ) {
        return CLIENT_GUARD_ID;
      }
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
