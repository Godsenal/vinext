/**
 * Serve Vite's module URLs before the Cloudflare plugin applies
 * `assets.runWorkerFirst` during development.
 *
 * `vinext init` generates `runWorkerFirst: ["/*", "!/_next/static/*", ...]` so
 * middleware runs for `public/` files. In dev, the Cloudflare plugin sends every
 * request matching those patterns to the Worker before Vite's own middlewares
 * run. That includes Vite's module URLs (`/@vite/client`, `/@id/*`, `/@fs/*`,
 * source files such as `/app/globals.css`), which have no production
 * equivalent, so the Worker answers them with the app's 404 page and nothing
 * hydrates.
 *
 * This plugin registers a pre-middleware ahead of the Cloudflare plugin's and
 * gives Vite's module-serving middlewares the first chance to handle each
 * request. Vite decides what it serves: page navigations, non-GET requests, and
 * unknown paths fall through to the Cloudflare plugin unchanged. Imported
 * assets are served by the Worker's dev fallback to the `ASSETS` binding
 * instead (see `server/dev-asset-fallback.ts`), so Worker routes always win
 * over project files.
 *
 * The same change was made in the Cloudflare plugin itself in
 * https://github.com/cloudflare/workers-sdk/pull/16281.
 *
 * See https://github.com/cloudflare/vinext/issues/4005.
 */
import type { Connect, Plugin, ViteDevServer } from "vite";

/**
 * Vite's internal middlewares that serve module requests (`/@vite/client`,
 * `/@id/*`, JS and CSS source files) and `/@fs/*` paths, preceded by the one
 * that strips a non-root `base` from the URL and the one that answers the HMR
 * client's reconnect ping (`Accept: text/x-vite-ping`) with a 204 instead of
 * the Worker rendering a page for it. If Vite renames them, none are found and
 * every request falls through, which is the behavior without this plugin.
 *
 * `viteServePublicMiddleware` is deliberately excluded so that `public/` files
 * reach the Worker and middleware, as they do in production. Without it, the
 * transform middleware reports a public `.js` or `.css` file as an
 * `ERR_LOAD_PUBLIC_URL` error, which is treated as a fall-through.
 */
const VITE_MODULE_MIDDLEWARE_NAMES = new Set([
  "viteBaseMiddleware",
  "viteHMRPingMiddleware",
  "viteTransformMiddleware",
  "viteServeRawFsMiddleware",
]);

/**
 * The Cloudflare plugin's middleware that sends requests matching
 * `runWorkerFirst` to the Worker. It's only registered when `runWorkerFirst` is
 * set, and without it Vite's middlewares already run in their usual order.
 */
const CLOUDFLARE_PRE_MIDDLEWARE_NAME = "cloudflarePreMiddleware";

type CloudflareDevModuleUrlsOptions = {
  /** Whether the Cloudflare Vite plugin is present. Read when the dev server starts. */
  isEnabled: () => boolean;
};

/**
 * Creates the plugin that lets Vite serve its module URLs before the Cloudflare
 * plugin's `runWorkerFirst` routing in dev.
 *
 * @param options - Plugin options
 * @returns The Vite plugin
 */
export function createCloudflareDevModuleUrlsPlugin(
  options: CloudflareDevModuleUrlsOptions,
): Plugin {
  return {
    name: "vinext:cloudflare-dev-module-urls",
    apply: "serve",
    // Pre-middlewares run in plugin order, and the Cloudflare plugin does not
    // set `enforce`, so this keeps vinext's middleware ahead of it regardless
    // of where the user lists `vinext()`.
    enforce: "pre",
    configureServer(server) {
      if (!options.isEnabled()) return;

      server.middlewares.use(function vinextCloudflareDevModuleUrls(req, res, next) {
        runViteModuleMiddlewares(server, req, res, next);
      });
    },
  };
}

/**
 * Runs Vite's module-serving middlewares in order, calling `next` once none of
 * them handle the request.
 *
 * @param server - The Vite dev server whose middleware stack is searched
 * @param req - The incoming request
 * @param res - The outgoing response
 * @param next - Called when no middleware handles the request, or with an error
 */
function runViteModuleMiddlewares(
  server: ViteDevServer,
  req: Connect.IncomingMessage,
  res: Parameters<Connect.NextHandleFunction>[1],
  next: Connect.NextFunction,
): void {
  // Vite only serves module URLs and files for GET and HEAD, and with a
  // non-root `base` (vinext sets it to `basePath + "/"`) only under it, so any
  // other request goes straight to the Worker.
  const url = req.url;
  if ((req.method !== "GET" && req.method !== "HEAD") || !url?.startsWith(server.config.base)) {
    next();
    return;
  }
  // Read the stack per request because Vite adds its internal middlewares
  // after the plugins' `configureServer` hooks have run. The base middleware is
  // only present with a non-root `base`, and strips it from `req.url` before
  // the module middlewares see the request.
  const stack = server.middlewares.stack;
  if (!stack.some((layer) => getHandleName(layer.handle) === CLOUDFLARE_PRE_MIDDLEWARE_NAME)) {
    next();
    return;
  }
  const handles = stack.flatMap((layer): Connect.NextHandleFunction[] => {
    const handle = layer.handle;
    return typeof handle === "function" && VITE_MODULE_MIDDLEWARE_NAMES.has(handle.name)
      ? [handle as Connect.NextHandleFunction]
      : [];
  });
  let index = 0;

  const tryNext = (error?: unknown): void => {
    if (isPublicFileLoadError(error)) {
      req.url = url;
      next();
      return;
    }
    if (error) {
      next(error);
      return;
    }

    const handle = handles[index++];
    if (!handle) {
      // The Cloudflare plugin matches `runWorkerFirst` against `req.url`, and
      // the Worker routes on it, so undo any rewrite by Vite's middlewares.
      req.url = url;
      next();
      return;
    }

    try {
      // Some of Vite's middlewares are async
      const result: unknown = handle(req, res, tryNext);
      if (result instanceof Promise) {
        result.catch(next);
      }
    } catch (e) {
      next(e);
    }
  };

  tryNext();
}

function getHandleName(handle: unknown): string | undefined {
  return typeof handle === "function" ? handle.name : undefined;
}

/**
 * Whether the transform middleware rejected a request because it is for a
 * `public/` file, which `viteServePublicMiddleware` would normally serve.
 */
function isPublicFileLoadError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ERR_LOAD_PUBLIC_URL"
  );
}
