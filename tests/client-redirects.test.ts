import { describe, expect, it, vi } from "vite-plus/test";
import { toClientRedirects } from "../packages/vinext/src/client/client-redirects.js";
import { toClientRewrites } from "../packages/vinext/src/client/client-rewrites.js";
import { matchClientRedirect } from "../packages/vinext/src/client/client-redirect-matcher.js";
import type { NextRedirect, NextRewrite } from "../packages/vinext/src/config/next-config.js";
import {
  hasUnsafeConditions,
  matchRedirect,
  type RequestContext,
} from "../packages/vinext/src/config/config-matchers.js";

function browserContext(query = ""): RequestContext {
  return {
    cookies: { "internal-access": "cookie-secret-canary" },
    headers: new Headers({ "x-origin-auth": "header-secret-canary" }),
    host: "localhost",
    query: new URLSearchParams(query),
  };
}

const basePathState = { basePath: "", hadBasePath: true };

describe("client redirects", () => {
  it("publishes neither the conditions nor the destination of server-owned rules", () => {
    const redirects = toClientRedirects([
      {
        source: "/header",
        destination: "/header-target-canary",
        permanent: false,
        has: [{ type: "header", key: "x-origin-auth", value: "header-secret-canary" }],
      },
      {
        source: "/cookie",
        destination: "/cookie-target-canary",
        permanent: true,
        missing: [{ type: "cookie", key: "internal-access", value: "cookie-secret-canary" }],
      },
      {
        source: "/future",
        destination: "/future-target-canary",
        permanent: false,
        // A condition type the public type does not know yet stays server-owned.
        has: [{ type: "future" as "header", key: "k", value: "future-secret-canary" }],
      },
    ]);

    expect(redirects).toEqual([
      { source: "/header", requiresServerEvaluation: true },
      { source: "/cookie", requiresServerEvaluation: true },
      { source: "/future", requiresServerEvaluation: true },
    ]);
    expect(JSON.stringify(redirects)).not.toMatch(/canary|x-origin-auth|internal-access/);
  });

  it("keeps browser-authoritative conditions as a prefilter", () => {
    expect(
      toClientRedirects([
        {
          source: "/mixed",
          destination: "/secret-target",
          permanent: false,
          has: [
            { type: "query", key: "from", value: "nav" },
            { type: "header", key: "x-origin-auth", value: "header-secret-canary" },
          ],
          missing: [{ type: "host", key: "", value: "internal.example" }],
        },
        {
          source: "/plain",
          destination: "/about",
          permanent: true,
          has: [{ type: "query", key: "preview", value: "1" }],
          basePath: false,
        },
      ]),
    ).toEqual([
      {
        source: "/mixed",
        has: [{ type: "query", key: "from", value: "nav" }],
        missing: [{ type: "host", key: "", value: "internal.example" }],
        requiresServerEvaluation: true,
      },
      {
        source: "/plain",
        has: [{ type: "query", key: "preview", value: "1" }],
        destination: "/about",
        permanent: true,
        basePath: false,
      },
    ]);
  });

  it("does not let a later rule replace a matching server-owned rule", () => {
    const redirects = toClientRedirects([
      {
        source: "/docs/:slug",
        destination: "/beta/:slug",
        permanent: false,
        has: [
          { type: "query", key: "from", value: "nav" },
          { type: "cookie", key: "internal-access", value: "cookie-secret-canary" },
        ],
      },
      { source: "/docs/:slug", destination: "/v2/:slug", permanent: false },
    ]);

    expect(
      matchClientRedirect("/docs/intro", redirects, browserContext("from=nav"), basePathState),
    ).toBeNull();
    // The client-safe prefilter rules the server-owned rule out, so the later
    // rule is the one the server would apply too.
    expect(
      matchClientRedirect("/docs/intro", redirects, browserContext("from=link"), basePathState),
    ).toMatchObject({ destination: "/v2/intro", permanent: false });
  });

  it("leaves out rules with a condition value the server rejects as unsafe", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      // The server never applies such a rule, so it must not defer to the
      // server or hide the later rule from the client either.
      const unsafe = [{ type: "header" as const, key: "x-auth", value: "[ab]*a[ab]*a[ab]*" }];
      const config = [
        { source: "/docs/:slug", destination: "/beta/:slug", permanent: false, has: unsafe },
        { source: "/docs/:slug", destination: "/v2/:slug", permanent: false },
      ];
      const redirects = toClientRedirects(config);
      expect(redirects.map((redirect) => redirect.destination)).toEqual(["/v2/:slug"]);
      const ctx = browserContext();
      expect(matchClientRedirect("/docs/intro", redirects, ctx, basePathState)).toMatchObject({
        destination: "/v2/intro",
      });
      expect(matchRedirect("/docs/intro", config, ctx, basePathState)).toMatchObject({
        destination: "/v2/intro",
      });

      const rewrites = toClientRewrites({
        beforeFiles: [{ source: "/a", destination: "/b", missing: unsafe }],
        afterFiles: [
          { source: "/a", destination: "/c", has: unsafe },
          { source: "/a", destination: "/d" },
        ],
        fallback: [],
      });
      expect(rewrites.beforeFiles).toEqual([]);
      expect(rewrites.afterFiles.map((rewrite) => rewrite.source)).toEqual(["/a"]);
    } finally {
      warn.mockRestore();
    }
  });

  it("publishes rewrites whose missing conditions are malformed", () => {
    // Config loading does not check condition shapes, so the unsafe-value
    // check must not throw on them while building the client manifests, nor
    // disable a rule for an entry the request matcher ignores.
    const unsafeValue = "[ab]*a[ab]*a[ab]*";
    const malformed = [
      [null],
      [{ type: "query" }],
      [{ value: unsafeValue }],
      [{ type: "unknown", key: "x", value: unsafeValue }],
      {},
      "x-auth",
    ] as unknown as NextRewrite["missing"][];
    for (const missing of malformed) {
      expect(hasUnsafeConditions({ missing })).toBe(false);
    }
    const rewrites = toClientRewrites({
      beforeFiles: malformed.map((missing) => ({ source: "/a", destination: "/b", missing })),
      afterFiles: [],
      fallback: [],
    });
    expect(rewrites.beforeFiles).toHaveLength(malformed.length);
    const ignored = [{ value: unsafeValue }] as unknown as NextRedirect["missing"];
    expect(
      matchRedirect(
        "/a",
        [{ source: "/a", destination: "/b", permanent: false, missing: ignored }],
        browserContext(),
        basePathState,
      ),
    ).toMatchObject({ destination: "/b" });
  });

  it("publishes condition values that are not strings unchanged", () => {
    // Config loading does not check condition shapes; only string values
    // are escaped for the client.
    const values = [Symbol("x"), ["("], 1];
    const has = values.map((value) => ({
      type: "query",
      key: "q",
      value,
    })) as unknown as NextRewrite["has"];
    const rewrites = toClientRewrites({
      beforeFiles: [{ source: "/a", destination: "/b", has }],
      afterFiles: [],
      fallback: [],
    });
    expect(rewrites.beforeFiles[0]?.has?.map((condition) => condition.value)).toEqual(values);
    const [redirect] = toClientRedirects([
      { source: "/a", destination: "/b", permanent: false, has, missing: has },
    ]);
    expect(redirect?.has?.map((condition) => condition.value)).toEqual(values);
    expect(redirect?.missing?.map((condition) => condition.value)).toEqual(values);
  });
});
