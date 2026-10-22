import { expect, test } from "@playwright/test";

const BASE = "http://localhost:4190";

// Next.js 16.2.7 prefixes the basePath before parsing the destination
// template, so `..` resolves against it and `/` becomes the bare basePath.
test("resolves the destination template after the basePath prefixes it", async ({ request }) => {
  for (const [pathname, location] of [
    ["/docs/basepath-dot-redirect/", "/outside"],
    ["/docs/basepath-root-redirect/", "/docs"],
  ]) {
    const res = await request.get(`${BASE}${pathname}`, { maxRedirects: 0 });
    expect(res.status()).toBe(307);
    expect(res.headers()["location"]).toBe(location);
  }
});
