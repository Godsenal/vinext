import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createBuilder } from "vite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import vinext from "../packages/vinext/src/index.js";
import { toClientRedirects } from "../packages/vinext/src/client/client-redirects.js";
import { toClientRewrites } from "../packages/vinext/src/client/client-rewrites.js";
import { matchClientRedirect } from "../packages/vinext/src/client/client-redirect-matcher.js";
import { matchClientRewrite } from "../packages/vinext/src/client/client-rewrite-matcher.js";
import {
  matchRedirect,
  requestContextFromRequest,
} from "../packages/vinext/src/config/config-matchers.js";
import type { NextRedirect } from "../packages/vinext/src/config/next-config.js";
import { clientConfigSourceGuardPlugin } from "../packages/vinext/src/plugins/client-config-source-guard.js";

const ROOT_NODE_MODULES = path.resolve(import.meta.dirname, "../node_modules");
const SRC = path.resolve(import.meta.dirname, "../packages/vinext/src");
const CLIENT_GUARD_ID = "\0vinext:client-config-source-guard";
// Only the analyzer reports this.
const ANALYZER_MARKER = "exponentially ambiguous repetition";
const UNSAFE_SOURCE = "/:id((?:a+)+)";
const UNSAFE_VALUE = "(?:a+)+";
const INVALID_VALUE = "(a[";
const BASE_PATH_STATE = { basePath: "", hadBasePath: false };

function resolveGuard(id: string, importer: string | undefined, consumer: string | undefined) {
  const { handler } = clientConfigSourceGuardPlugin.resolveId as {
    handler: (id: string, importer: string | undefined) => string | undefined;
  };
  return handler.call(
    { environment: consumer ? { config: { consumer } } : undefined },
    id,
    importer,
  );
}

describe("vinext:client-config-source-guard", () => {
  const importer = path.join(SRC, "config", "config-matchers.ts");

  it("swaps the guard config-matchers imports only in client environments", () => {
    expect(resolveGuard("./config-source-guard.js", importer, "client")).toBe(CLIENT_GUARD_ID);
    expect(resolveGuard("./config-source-guard.js", `${importer}?v=1`, "client")).toBe(
      CLIENT_GUARD_ID,
    );
    expect(resolveGuard("./config-source-guard.js", importer, "server")).toBeUndefined();
    expect(resolveGuard("./config-source-guard.js", importer, undefined)).toBeUndefined();
  });

  it("leaves other modules with the same name alone", () => {
    expect(
      resolveGuard("./config-source-guard.js", "/app/src/config-matchers.ts", "client"),
    ).toBeUndefined();
    expect(resolveGuard("./config-source-guard.js", undefined, "client")).toBeUndefined();
  });
});

describe("rules published to client builds", () => {
  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("leaves out rules whose source the server skips", () => {
    const redirects: NextRedirect[] = [
      { source: UNSAFE_SOURCE, destination: "/unsafe", permanent: false },
      { source: "/old", destination: "/new", permanent: false },
    ];
    expect(toClientRedirects(redirects).map((redirect) => redirect.source)).toEqual(["/old"]);
    const rewrites = toClientRewrites({
      beforeFiles: [{ source: UNSAFE_SOURCE, destination: "/unsafe" }],
      afterFiles: [{ source: "/a", destination: "/b" }],
      fallback: [{ source: UNSAFE_SOURCE, destination: "/unsafe" }],
    });
    expect(rewrites.beforeFiles).toEqual([]);
    expect(rewrites.afterFiles.map((rewrite) => rewrite.source)).toEqual(["/a"]);
    expect(rewrites.fallback).toEqual([]);
  });

  it("leaves out rules with a condition value the server rejects as unsafe", () => {
    const redirects: NextRedirect[] = [
      {
        source: "/has",
        destination: "/unsafe",
        permanent: false,
        has: [{ type: "query", key: "q", value: UNSAFE_VALUE }],
      },
      // A server-only condition still keeps the rule from ever applying.
      {
        source: "/missing",
        destination: "/unsafe",
        permanent: false,
        missing: [{ type: "header", key: "x-skip", value: UNSAFE_VALUE }],
      },
      { source: "/old", destination: "/new", permanent: false },
    ];
    expect(toClientRedirects(redirects).map((redirect) => redirect.source)).toEqual(["/old"]);
    const rewrites = toClientRewrites({
      beforeFiles: [
        { source: "/a", destination: "/b", has: [{ type: "host", key: "", value: UNSAFE_VALUE }] },
      ],
      afterFiles: [],
      fallback: [],
    });
    expect(rewrites.beforeFiles).toEqual([]);
  });

  it("publishes a condition value the server compares as text as a regex for that text", () => {
    const redirect: NextRedirect = {
      source: "/old",
      destination: "/new",
      permanent: false,
      has: [{ type: "query", key: "q", value: INVALID_VALUE }],
      missing: [{ type: "query", key: "m", value: "a|b" }],
    };
    const [published] = toClientRedirects([redirect]);
    expect(published!.has).toEqual([{ type: "query", key: "q", value: "\\(a\\[" }]);
    // A valid value is published unchanged.
    expect(published!.missing).toEqual([{ type: "query", key: "m", value: "a|b" }]);

    for (const query of [`?q=${encodeURIComponent(INVALID_VALUE)}`, "?q=a", "?q=(a"]) {
      const ctx = requestContextFromRequest(new Request(`http://localhost/old${query}`));
      expect(
        matchClientRedirect("/old", [published!], ctx, BASE_PATH_STATE)?.destination ?? null,
        query,
      ).toBe(matchRedirect("/old", [redirect], ctx, BASE_PATH_STATE)?.destination ?? null);
    }
    const literal = requestContextFromRequest(
      new Request(`http://localhost/old?q=${encodeURIComponent(INVALID_VALUE)}`),
    );
    expect(matchClientRedirect("/old", [published!], literal, BASE_PATH_STATE)).not.toBeNull();

    const [rewrite] = toClientRewrites({
      beforeFiles: [
        { source: "/a", destination: "/b", has: [{ type: "host", key: "", value: INVALID_VALUE }] },
      ],
      afterFiles: [],
      fallback: [],
    }).beforeFiles;
    expect(rewrite!.has).toEqual([{ type: "host", key: "", value: "\\(a\\[" }]);
    const ctx = requestContextFromRequest(new Request("http://a/a"));
    expect(matchClientRewrite("/a", rewrite!, ctx, BASE_PATH_STATE)).toBeNull();
  });
});

async function writeFile(file: string, source: string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, source, "utf8");
}

async function readTree(dir: string): Promise<string> {
  const entries = await fs.readdir(dir, { recursive: true, withFileTypes: true });
  const files = entries.filter((entry) => entry.isFile() && /\.m?js$/.test(entry.name));
  const sources = await Promise.all(
    files.map((entry) => fs.readFile(path.join(entry.parentPath, entry.name), "utf8")),
  );
  return sources.join("\n");
}

describe("client build", () => {
  it("ships the config matchers without the ReDoS analyzer or unsafe rules", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "vinext-client-config-guard-"));
    try {
      await fs.symlink(ROOT_NODE_MODULES, path.join(root, "node_modules"), "junction");
      await writeFile(path.join(root, "package.json"), `{ "type": "module" }\n`);
      await writeFile(
        path.join(root, "pages", "index.tsx"),
        `export default function Page() { return <p>home</p>; }\n`,
      );
      await writeFile(
        path.join(root, "next.config.mjs"),
        `export default {
  async redirects() {
    return [
      { source: ${JSON.stringify(UNSAFE_SOURCE)}, destination: "/unsafe-redirect", permanent: false },
      { source: "/unsafe-value", destination: "/", permanent: false, has: [{ type: "query", key: "q", value: ${JSON.stringify(UNSAFE_VALUE)} }] },
      { source: "/old", destination: "/", permanent: false, has: [{ type: "query", key: "q", value: ${JSON.stringify(INVALID_VALUE)} }] },
    ];
  },
  async rewrites() {
    return [{ source: "/about", destination: "/" }];
  },
};
`,
      );
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        const builder = await createBuilder({
          root,
          configFile: false,
          logLevel: "silent",
          plugins: [vinext({ appDir: root })],
        });
        await builder.buildApp();
      } finally {
        warn.mockRestore();
      }

      const client = await readTree(path.join(root, "dist", "client"));
      // The client still bundles config-matchers for its rules, without the
      // analyzer it reaches through the guard.
      expect(client).toContain("Ignoring next.config.js source");
      expect(client).toContain("/about");
      expect(client).not.toContain(ANALYZER_MARKER);
      expect(client).not.toContain("/unsafe-redirect");
      expect(client).not.toContain("/unsafe-value");
      expect(client).toContain(JSON.stringify("\\(a\\[").slice(1, -1));
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  }, 120_000);
});
