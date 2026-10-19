import { test, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { waitForHydration } from "../helpers";

/**
 * The client build matches config redirects and rewrites with config-matchers
 * but without the ReDoS analyzer: the server only publishes rules it checked.
 */
const BASE = "http://localhost:4175";
const CLIENT_DIR = path.resolve(process.cwd(), "tests/fixtures/pages-basic/dist/client");

function readClientScripts(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) return readClientScripts(entryPath);
    return entry.name.endsWith(".js") ? [fs.readFileSync(entryPath, "utf8")] : [];
  });
}

test.describe("Client config matching without the ReDoS analyzer (Pages Router production)", () => {
  test("client assets bundle config-matchers but not the analyzer", () => {
    const scripts = readClientScripts(CLIENT_DIR);
    expect(scripts.some((script) => script.includes("Ignoring next.config.js source"))).toBe(true);
    expect(scripts.some((script) => script.includes("exponentially ambiguous repetition"))).toBe(
      false,
    );
  });

  test("client navigation applies a redirect with a regex condition", async ({ baseURL, page }) => {
    const base = baseURL ?? BASE;
    await page.goto(`${base}/`);
    await waitForHydration(page);

    // `has: [{ type: "query", key: "to", value: "(?<to>.*)" }]` is evaluated by
    // config-matchers in the browser, so the navigation stays client-side.
    await page.evaluate(() => {
      (window as any).__softNavigation = true;
      return (window as any).next.router.push("/query-capture-redirect?to=about");
    });
    await expect(page.locator("h1")).toHaveText("About");
    expect(new URL(page.url()).pathname).toBe("/about");
    expect(await page.evaluate(() => (window as any).__softNavigation)).toBe(true);
  });
});
