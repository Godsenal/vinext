/**
 * Serves a file through the `ASSETS` binding when the Worker has nothing at a
 * URL during development.
 *
 * `vinext init` generates `runWorkerFirst: ["/*", "!/_next/static/*", ...]` so
 * middleware runs for `public/` files. In dev, the Cloudflare Vite plugin sends
 * every matching request to the Worker before Vite's own middlewares run,
 * including the URLs Vite gives imported assets (`import logo from
 * "./logo.svg"`, `?url`, and CSS `url()` all resolve to paths like
 * `/app/logo.svg`). In production those files are under `/_next/static/`, which
 * never reaches the Worker, but in dev the Worker has no route for them.
 *
 * In dev, the Cloudflare plugin's `ASSETS` binding runs Vite's middlewares, so
 * when the Worker answers a GET or HEAD request with a 404, this asks Vite for
 * the URL instead. Worker routes always win, and only a successful response
 * from Vite replaces the 404.
 *
 * See https://github.com/cloudflare/vinext/issues/4005.
 */

type AssetsBinding = {
  fetch(request: Request): Promise<Response> | Response;
};

/**
 * Returns Vite's response for `request` when the Worker's response is a 404
 * that Vite can serve, otherwise the Worker's response.
 *
 * @param request - The request the Worker handled
 * @param env - The Worker's bindings
 * @param response - The Worker's response
 * @returns The response to send
 */
export async function fetchDevAssetOnNotFound(
  request: Request,
  env: { ASSETS?: AssetsBinding } | undefined,
  response: Response,
): Promise<Response> {
  const assets = env?.ASSETS;
  if (
    !assets ||
    response.status !== 404 ||
    (request.method !== "GET" && request.method !== "HEAD")
  ) {
    return response;
  }

  let asset: Response;
  try {
    asset = await assets.fetch(new Request(request.url, request));
  } catch {
    return response;
  }
  // Vite answers files it won't serve, such as `.env`, with a 403, and those
  // keep the Worker's 404.
  if (!asset.ok && asset.status !== 304) {
    cancelBody(asset);
    return response;
  }
  cancelBody(response);
  return asset;
}

function cancelBody(response: Response): void {
  if (!response.body || response.body.locked) return;
  void response.body.cancel().catch(() => {
    /* ignore cancellation failures on discarded bodies */
  });
}
