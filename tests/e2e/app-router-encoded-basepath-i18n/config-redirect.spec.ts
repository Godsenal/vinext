import { expect, test } from "@playwright/test";

const BASE = "http://localhost:4196";

// Next.js 16.2.7 prefixes the basePath, and the locale for a non-default
// locale, before parsing the destination template, so `..` resolves against
// them: the default-locale rule escapes the basePath and the `fr` one does not.
test("resolves dot segments after the basePath and locale prefix the destination", async ({
  request,
}) => {
  for (const [pathname, location] of [
    ["/docs/basepath-dot-redirect", "/outside"],
    ["/docs/fr/basepath-dot-redirect", "/docs/outside"],
  ]) {
    const res = await request.get(`${BASE}${pathname}`, { maxRedirects: 0 });
    expect(res.status()).toBe(307);
    expect(res.headers()["location"]).toBe(location);
  }
});
