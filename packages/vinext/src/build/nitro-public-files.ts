import path from "pathslash";
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
// static output from a CDN that the server bundle does not ship with.
const CDN_STATIC_PRESETS = new Set(["aws-amplify"]);

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

  // Nitro serves each asset directory below its own `baseURL`.
  const requestPrefix = (assetBaseURL: string) => nitroBase + assetBaseURL;
  const publicAssets = options.publicAssets ?? [];
  const routed = publicAssets.find((asset) => asset.baseURL?.startsWith(NITRO_PUBLIC_FILES_BASE));
  if (routed?.baseURL) return requestPrefix(routed.baseURL);

  const asset = publicAssets.find(
    (candidate) =>
      path.resolve(candidate.dir) === path.resolve(publicDir) && (candidate.baseURL ?? "/") === "/",
  );
  if (!asset) return null;

  asset.baseURL = NITRO_PUBLIC_FILES_BASE + secret;
  asset.fallthrough = false;
  options.virtual ??= {};
  options.virtual[NITRO_PUBLIC_FILES_PLUGIN] = [
    "export default function vinextNitroPublicFiles(nitroApp) {",
    `  globalThis[Symbol.for(${JSON.stringify(NITRO_APP_FETCH_KEY)})] = (request) => nitroApp.fetch(request);`,
    "}",
    "",
  ].join("\n");
  options.plugins ??= [];
  options.plugins.push(NITRO_PUBLIC_FILES_PLUGIN);
  return requestPrefix(asset.baseURL);
}
