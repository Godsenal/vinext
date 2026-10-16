import fs from "node:fs";
import path, { toSlash } from "pathslash";
import { NITRO_APP_FETCH_KEY } from "../server/nitro-public-files.js";

type NitroPublicAssetDir = {
  dir: string;
  baseURL?: string;
  fallthrough?: boolean;
};

/** The Nitro options this integration reads and updates. */
export type NitroPublicFilesOptions = {
  dev?: boolean;
  preset?: string;
  baseURL?: string;
  serveStatic?: boolean | string;
  publicAssets?: NitroPublicAssetDir[];
  plugins?: string[];
  virtual?: Record<string, unknown>;
};

const NITRO_PUBLIC_FILES_BASE = "/_vinext/public/";
const NITRO_PUBLIC_FILES_PLUGIN = "#vinext/nitro-public-files";
// Presets that turn on `serveStatic` although their platform serves the
// static output before the server runs: Amplify's CDN, and IIS, which
// iisnode's generated `web.config` lets answer files on disk first.
const CDN_STATIC_PRESETS = new Set(["aws-amplify", "iis-node"]);
// The private prefix's shape, below any Nitro `baseURL`; the secret is
// 16 random bytes in hex.
const NITRO_PUBLIC_FILES_PATH_RE = /(?:^|\/)_vinext\/public\/[0-9a-f]{32}(?:\/|$)/;

/**
 * Define the Nitro runtime plugin that lets vinext's router fetch public
 * files in-process. Nitro reads virtual modules when it sets up, before Vite
 * resolves its config, so this runs from Nitro's setup hook and reads the
 * prefix when Nitro renders the module; the plugin only loads once
 * `routeNitroPublicFilesThroughRouter` registers it.
 *
 * Nitro's static handler answers before any request hook can reject a
 * request, so the plugin wraps the app's `fetch` to keep requests from
 * outside the server away from the private prefix. vinext's own fetches use
 * the unwrapped app.
 */
export function defineNitroPublicFilesPlugin(
  options: NitroPublicFilesOptions,
  getPrefix: () => string | null,
): void {
  options.virtual ??= {};
  options.virtual[NITRO_PUBLIC_FILES_PLUGIN] = () => {
    const prefix = getPrefix();
    if (!prefix) return "export default function vinextNitroPublicFiles() {}\n";
    return [
      `const prefix = ${JSON.stringify(prefix)};`,
      "export default function vinextNitroPublicFiles(nitroApp) {",
      "  const appFetch = nitroApp.fetch;",
      `  globalThis[Symbol.for(${JSON.stringify(NITRO_APP_FETCH_KEY)})] = appFetch;`,
      "  nitroApp.fetch = (request) => {",
      "    let pathname = new URL(request.url).pathname;",
      // Nitro's static handler decodes the path before it looks up assets.
      "    try { pathname = decodeURIComponent(pathname); } catch {}",
      '    return pathname === prefix || pathname.startsWith(prefix + "/")',
      "      ? new Response(null, { status: 404 })",
      "      : appFetch(request);",
      "  };",
      "}",
      "",
    ].join("\n");
  };
}

/**
 * Route public/ files through vinext's router on Nitro presets that serve
 * static files in-process.
 *
 * Next.js runs middleware before it checks public/ files, but Nitro's static
 * handler answers before vinext's handler. This serves the public/ directory
 * under a prefix only the server knows, so requests reach the router, and
 * registers a runtime plugin that lets the router fetch files from there.
 * On presets whose platform serves static files, the platform answers before
 * Nitro runs at all, so they keep Nitro's routing.
 *
 * `publicDir` is Vite's resolved public directory, which vinext's router
 * serves below `basePath`. Returns the prefix requests use, including
 * Nitro's `baseURL`, or null when public/ stays with Nitro's static handler.
 */
export function routeNitroPublicFilesThroughRouter(
  options: NitroPublicFilesOptions,
  { basePath, publicDir, secret }: { basePath: string; publicDir: string | null; secret: string },
): string | null {
  if (options.dev || !options.serveStatic || !publicDir) return null;
  if (options.preset && CDN_STATIC_PRESETS.has(options.preset.replaceAll("_", "-"))) return null;
  // Nitro passes request paths to vinext unchanged, so the router finds
  // public files only when Nitro's `baseURL` is the root or the basePath.
  const nitroBase = (options.baseURL ?? "/").replace(/\/+$/, "");
  if (nitroBase && nitroBase !== basePath) return null;

  // Vite resolves publicDir through symlinks; Nitro keeps the path it got.
  const realPublicDir = realPath(publicDir);
  const asset = options.publicAssets?.find(
    (candidate) =>
      realPath(candidate.dir) === realPublicDir &&
      ((candidate.baseURL ?? "/") === "/" ||
        candidate.baseURL?.startsWith(NITRO_PUBLIC_FILES_BASE)),
  );
  if (!asset) return null;

  // A repeated call keeps the first prefix.
  const baseURL = asset.baseURL?.startsWith(NITRO_PUBLIC_FILES_BASE)
    ? asset.baseURL
    : NITRO_PUBLIC_FILES_BASE + secret;
  asset.baseURL = baseURL;
  asset.fallthrough = false;
  options.plugins ??= [];
  if (!options.plugins.includes(NITRO_PUBLIC_FILES_PLUGIN)) {
    options.plugins.push(NITRO_PUBLIC_FILES_PLUGIN);
  }
  // Nitro serves each asset directory below its own `baseURL`.
  return nitroBase + baseURL;
}

function realPath(dir: string): string {
  try {
    return path.resolve(fs.realpathSync(dir));
  } catch {
    return path.resolve(dir);
  }
}

/**
 * Whether a `vite preview` request names a path under the private public
 * files prefix. Nitro's preview serves its public output before the server
 * entry, so the runtime plugin's guard never sees these requests. The prefix
 * is random per build, so this matches its shape.
 */
export function isNitroPublicFilesPreviewPath(url: string): boolean {
  let pathname = new URL(url, "http://localhost").pathname;
  try {
    pathname = decodeURIComponent(pathname);
  } catch {}
  return NITRO_PUBLIC_FILES_PATH_RE.test(toSlash(pathname));
}
