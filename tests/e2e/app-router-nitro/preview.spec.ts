import { test, expect, type APIResponse } from "@playwright/test";
import { defineNitroAppTests } from "./app-tests";

// examples/app-router-nitro built with `vite build` and served by
// `vite preview`, which runs Nitro's own server output (#853).

test.describe("App Router on Nitro (vite preview)", () => {
  defineNitroAppTests();

  // Next.js runs middleware before it serves public/ files (#3217). Dev
  // serves them from Vite before middleware, so this is preview-only.
  test("runs middleware before serving public files", async ({ request }) => {
    const response = await request.get("/hello.txt");
    expect(response.status()).toBe(200);
    expect(response.headers()["x-vinext-middleware"]).toBe("active");
    expect(await response.text()).toBe("Hello from public/\n");
  });

  // `revalidate` pages are cached by vinext's own ISR cache, not by Nitro
  // route rules.
  test("serves revalidate pages from the ISR cache", async ({ request }) => {
    const renderedAt = async (response: APIResponse) =>
      /data-testid="isr-timestamp"[^>]*>Rendered at: (?:<!-- -->)?([^<]+)</.exec(
        await response.text(),
      )?.[1];

    // The cache write lands after the response stream finishes, so poll for
    // the first HIT before asserting that a later request replays it.
    let hit: APIResponse | undefined;
    await expect
      .poll(
        async () => {
          hit = await request.get("/isr");
          return hit.headers()["x-vinext-cache"];
        },
        { timeout: 5_000, intervals: [50, 100, 250] },
      )
      .toBe("HIT");
    const hitRenderedAt = await renderedAt(hit!);
    expect(hitRenderedAt).toBeTruthy();

    const replay = await request.get("/isr");
    expect(replay.status()).toBe(200);
    expect(replay.headers()["x-vinext-cache"]).toBe("HIT");
    expect(await renderedAt(replay)).toBe(hitRenderedAt);
  });
});
