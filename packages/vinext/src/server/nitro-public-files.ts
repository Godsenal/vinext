import type { VinextAssetFetcher } from "./multi-stage.js";
import { createStaticAssetRequest, resolveStaticAssetSignal } from "./worker-utils.js";

/**
 * Global symbol key under which vinext's Nitro runtime plugin publishes the
 * Nitro app's in-process `fetch`.
 */
export const NITRO_APP_FETCH_KEY = "vinext.nitro.appFetch";

const NITRO_ASSET_FALLBACK_HEADER = "x-vinext-nitro-asset-fallback";

type NitroAppFetch = (request: Request) => Response | Promise<Response>;

function getNitroAppFetch(): NitroAppFetch {
  const appFetch: unknown = Reflect.get(globalThis, Symbol.for(NITRO_APP_FETCH_KEY));
  if (typeof appFetch !== "function") {
    throw new Error("[vinext] The Nitro public files plugin did not register the app fetch.");
  }
  return appFetch as NitroAppFetch;
}

/**
 * Serve deployment assets through Nitro's own static handler.
 *
 * Next.js checks public/ files after middleware, but Nitro answers static
 * files before any handler runs. On presets that serve static files
 * in-process, the build moves public/ under a secret `prefix`, so requests
 * reach vinext's router, and the router fetches the file from there once it
 * resolves a public file. Client build output stays at Nitro's root; a miss
 * under the prefix retries there, marked so it cannot re-enter the router.
 * These requests go through Nitro's app, so its request hooks see the prefix.
 */
export function createNitroAssetFetcher(prefix: string): VinextAssetFetcher {
  return {
    async fetch(request) {
      const appFetch = getNitroAppFetch();
      const publicUrl = new URL(request.url);
      publicUrl.pathname = prefix + publicUrl.pathname;
      const response = await appFetch(new Request(publicUrl, request));
      if (response.status !== 404) return response;

      await response.body?.cancel();
      const headers = new Headers(request.headers);
      headers.set(NITRO_ASSET_FALLBACK_HEADER, prefix);
      return appFetch(new Request(request, { headers }));
    },
  };
}

/**
 * Answer a request that must not reach the router: an asset fallback that
 * Nitro's static handler did not serve, or a path under the private prefix.
 */
export function nitroPublicFilesGuardResponse(request: Request, prefix: string): Response | null {
  const { pathname } = new URL(request.url);
  return request.headers.get(NITRO_ASSET_FALLBACK_HEADER) === prefix ||
    pathname === prefix ||
    pathname.startsWith(prefix + "/")
    ? new Response(null, { status: 404 })
    : null;
}

type NitroFetchEntry = {
  fetch(request: Request): Promise<Response>;
};

/**
 * Wrap the App Router SSR service that Nitro dispatches requests to, so a
 * public file the router resolves is served through Nitro's static handler.
 */
export function withNitroPublicFiles(entry: NitroFetchEntry, prefix: string): NitroFetchEntry {
  const assets = createNitroAssetFetcher(prefix);
  return {
    async fetch(request) {
      const guard = nitroPublicFilesGuardResponse(request, prefix);
      if (guard) return guard;
      const response = await entry.fetch(request);
      const assetResponse = await resolveStaticAssetSignal(response, {
        fetchAsset: async (path, requestHeaders) =>
          assets.fetch(createStaticAssetRequest(path, request, requestHeaders)),
      });
      return assetResponse ?? response;
    },
  };
}

type PagesWorkerEntry<Env, Context extends object> = {
  fetch(request: Request, env: Env, ctx: Context & { assets?: VinextAssetFetcher }): unknown;
};

/**
 * Give the Pages Router worker that Nitro dispatches requests to an asset
 * fetcher, so a public file the router resolves is served through Nitro's
 * static handler.
 */
export function withNitroPagesPublicFiles<Env, Context extends object>(
  worker: PagesWorkerEntry<Env, Context>,
  prefix: string,
): PagesWorkerEntry<Env, Context> {
  const assets = createNitroAssetFetcher(prefix);
  return {
    fetch(request, env, ctx) {
      return (
        nitroPublicFilesGuardResponse(request, prefix) ??
        worker.fetch(request, env, { ...ctx, assets })
      );
    },
  };
}
