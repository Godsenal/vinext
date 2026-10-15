/**
 * Dev asset fallback tests — verifies that, in dev, the Worker asks the
 * `ASSETS` binding (Vite's middlewares) for a URL only when it has nothing
 * there itself.
 *
 * See https://github.com/cloudflare/vinext/issues/4005.
 */
import { describe, it, expect, vi } from "vite-plus/test";
import { fetchDevAssetOnNotFound } from "../packages/vinext/src/server/dev-asset-fallback.js";

const URL_ = "http://localhost/app/logo.svg";

function assetsReturning(response: Response | Error) {
  return {
    fetch: vi.fn(async (_request: Request) => {
      if (response instanceof Error) throw response;
      return response;
    }),
  };
}

describe("fetchDevAssetOnNotFound", () => {
  it("serves the asset when the Worker has nothing at the URL", async () => {
    const assets = assetsReturning(new Response("<svg />", { status: 200 }));
    const response = await fetchDevAssetOnNotFound(
      new Request(URL_, { headers: { accept: "image/*" } }),
      { ASSETS: assets },
      new Response("not found", { status: 404 }),
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("<svg />");
    const [request] = assets.fetch.mock.calls[0] ?? [];
    expect(request?.url).toBe(URL_);
    expect(request?.headers.get("accept")).toBe("image/*");
  });

  it("passes a 304 from Vite through for a conditional request", async () => {
    const response = await fetchDevAssetOnNotFound(
      new Request(URL_, { headers: { "if-none-match": '"abc"' } }),
      { ASSETS: assetsReturning(new Response(null, { status: 304 })) },
      new Response("not found", { status: 404 }),
    );

    expect(response.status).toBe(304);
  });

  it("keeps the Worker's response when it isn't a 404", async () => {
    const assets = assetsReturning(new Response("<svg />"));
    for (const status of [200, 307, 403, 500]) {
      const response = await fetchDevAssetOnNotFound(
        new Request(URL_),
        { ASSETS: assets },
        new Response("worker", { status }),
      );
      expect(response.status).toBe(status);
    }
    expect(assets.fetch).not.toHaveBeenCalled();
  });

  it("keeps the Worker's 404 for requests other than GET and HEAD", async () => {
    const assets = assetsReturning(new Response("<svg />"));
    const response = await fetchDevAssetOnNotFound(
      new Request(URL_, { method: "POST", body: "x" }),
      { ASSETS: assets },
      new Response("not found", { status: 404 }),
    );

    expect(response.status).toBe(404);
    expect(assets.fetch).not.toHaveBeenCalled();
  });

  it("keeps the Worker's 404 when Vite doesn't serve the URL", async () => {
    // Vite answers a missing file with a 404, and a denied one such as `.env` with a 403
    for (const asset of [
      new Response("missing", { status: 404 }),
      new Response("denied", { status: 403 }),
      new Error("binding failed"),
    ]) {
      const response = await fetchDevAssetOnNotFound(
        new Request(URL_),
        { ASSETS: assetsReturning(asset) },
        new Response("worker 404", { status: 404 }),
      );
      expect(response.status).toBe(404);
      expect(await response.text()).toBe("worker 404");
    }
  });

  it("keeps the Worker's 404 without an ASSETS binding", async () => {
    const response = await fetchDevAssetOnNotFound(
      new Request(URL_),
      undefined,
      new Response("worker 404", { status: 404 }),
    );

    expect(await response.text()).toBe("worker 404");
  });
});
