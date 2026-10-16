/**
 * Middleware runs for public/ files on Nitro presets that serve static files
 * in-process.
 *
 * Next.js checks public/ files after middleware (router-server.ts), so a
 * matcher that covers a public file must run middleware before the file is
 * served. Nitro's static middleware answers before any handler, so vinext
 * serves public/ through its own router on these presets.
 *
 * Ported from Next.js: test/e2e/middleware-static-files/index.test.ts
 * https://github.com/vercel/next.js/blob/canary/test/e2e/middleware-static-files/index.test.ts
 */

import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createBuilder, type Plugin } from "vite";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import vinext from "../packages/vinext/src/index.js";

const NITRO_NODE_MODULES = path.resolve(
  import.meta.dirname,
  "../examples/app-router-nitro/node_modules",
);

async function getAvailablePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return port;
}

async function waitForServer(url: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      await fetch(url);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw new Error(`Timed out waiting for ${url}`);
}

async function stopServer(server: ChildProcess | undefined): Promise<void> {
  if (!server || server.exitCode !== null || server.signalCode !== null) return;
  const exited = new Promise<void>((resolve) => server.once("exit", () => resolve()));
  server.kill("SIGTERM");
  await Promise.race([exited, new Promise<void>((resolve) => setTimeout(resolve, 3_000))]);
}

type NitroModule = { nitro(config?: Record<string, unknown>): Plugin[] };

async function writeFiles(root: string, files: Record<string, string>): Promise<void> {
  await fs.symlink(NITRO_NODE_MODULES, path.join(root, "node_modules"), "junction");
  await fs.writeFile(path.join(root, "package.json"), JSON.stringify({ type: "module" }));
  await Promise.all(
    Object.entries(files).map(async ([file, content]) => {
      await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true });
      await fs.writeFile(path.join(root, file), content);
    }),
  );
}

/** Build the app with Nitro's node-server preset and start its server. */
async function buildAndStart(
  root: string,
  nitroConfig: Record<string, unknown>,
  laterPlugins: Plugin[] = [],
): Promise<{ server: ChildProcess; baseUrl: string }> {
  const nitroModule = (await import(
    pathToFileURL(path.join(NITRO_NODE_MODULES, "nitro/dist/vite.mjs")).href
  )) as NitroModule;
  const builder = await createBuilder({
    root,
    configFile: false,
    logLevel: "silent",
    plugins: [
      vinext({ appDir: root }),
      nitroModule.nitro({ buildDir: path.join(root, ".nitro"), ...nitroConfig }),
      ...laterPlugins,
    ],
  });
  await builder.buildApp();

  const port = await getAvailablePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const server = spawn(process.execPath, [path.join(root, ".output/server/index.mjs")], {
    cwd: root,
    env: { ...process.env, HOST: "127.0.0.1", PORT: String(port) },
    stdio: "ignore",
  });
  return { server, baseUrl };
}

const LAYOUT = `export default function Root({ children }) {
  return <html><body>{children}</body></html>;
}
`;

const SVG = '<svg xmlns="http://www.w3.org/2000/svg"></svg>\n';
// Over Nitro's 1 KiB threshold for precompressed public assets.
const LARGE_TEXT = "compressed public file\n".repeat(100);

describe("App Router on Nitro: middleware for public files", () => {
  let root = "";
  let server: ChildProcess | undefined;
  let baseUrl = "";

  beforeAll(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "vinext-nitro-public-middleware-"));
    await writeFiles(root, {
      "app/layout.tsx": LAYOUT,
      "app/page.tsx": `export default function Page() { return <p>home</p>; }\n`,
      "app/another/hello/page.tsx": `export default function Page() { return <p>hello</p>; }\n`,
      "public/file.svg": SVG,
      "public/vercel copy.svg": SVG,
      "public/another/file.svg": SVG,
      "public/glob/file.svg": SVG,
      "public/pass.txt": "passed through",
      "public/unmatched.txt": "not matched",
      "public/large.txt": LARGE_TEXT,
      "public/docs/index.html": "<p>docs index</p>",
      "middleware.ts": `import { NextResponse } from "next/server";

export const config = {
  matcher: [
    "/file.svg",
    "/vercel copy.svg",
    "/another/file.svg",
    "/another/hello",
    "/glob/:path*",
    "/pass.txt",
    "/rewrite-to-file",
  ],
};

export default function middleware(request) {
  const { pathname } = request.nextUrl;
  if (pathname === "/pass.txt") {
    const response = NextResponse.next();
    response.headers.set("x-middleware", "ran");
    return response;
  }
  if (pathname === "/rewrite-to-file") {
    return NextResponse.rewrite(new URL("/unmatched.txt", request.url));
  }
  return NextResponse.json({ middleware: true });
}
`,
    });

    ({ server, baseUrl } = await buildAndStart(root, { compressPublicAssets: { gzip: true } }));
    await waitForServer(baseUrl);
  }, 180_000);

  afterAll(async () => {
    await stopServer(server);
    if (root) await fs.rm(root, { recursive: true, force: true });
  });

  // Upstream accepts either outcome for every path. The paths that name a
  // public file or page exactly must run middleware.
  it.each([
    "/file.svg",
    "/vercel copy.svg",
    "/vercel%20copy.svg",
    "/another/file.svg",
    "/another/hello",
    "/glob/file.svg",
  ])("runs middleware for %s", async (testPath) => {
    const response = await fetch(`${baseUrl}${testPath}`, { redirect: "manual" });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ middleware: true });
  });

  it.each(["/another%2ffile.svg", "/another%2fhello", "/glob%2ffile.svg"])(
    "should match middleware correctly for %s",
    async (testPath) => {
      const response = await fetch(`${baseUrl}${testPath}`, { redirect: "manual" });

      if (response.status === 404) {
        expect(await response.text()).toContain("page could not be found");
      } else {
        expect(await response.json()).toEqual({ middleware: true });
      }
    },
  );

  it("serves a public file after middleware passes it through", async () => {
    const response = await fetch(`${baseUrl}/pass.txt`);
    expect(response.status).toBe(200);
    expect(response.headers.get("x-middleware")).toBe("ran");
    expect(await response.text()).toBe("passed through");
  });

  it("serves a public file that middleware rewrites to", async () => {
    const response = await fetch(`${baseUrl}/rewrite-to-file`);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("not matched");
  });

  it("serves public files the matcher does not cover", async () => {
    const response = await fetch(`${baseUrl}/unmatched.txt`);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("not matched");
  });

  it("serves Nitro's precompressed public files", async () => {
    const response = await fetch(`${baseUrl}/large.txt`, {
      headers: { "accept-encoding": "gzip" },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-encoding")).toBe("gzip");
    expect(await response.text()).toBe(LARGE_TEXT);
  });

  it("does not route requests under the private prefix", async () => {
    const [secret] = await fs.readdir(path.join(root, ".output/public/_vinext/public"));
    const prefix = `/_vinext/public/${secret}`;

    const fallback = await fetch(`${baseUrl}/pass.txt`, {
      headers: { "x-vinext-nitro-asset-fallback": prefix },
    });
    expect(fallback.status).toBe(404);
    expect(await fallback.text()).toBe("");

    // Nitro's static handler would answer these before middleware runs.
    for (const [method, url] of [
      ["GET", `${baseUrl}${prefix}/pass.txt`],
      ["HEAD", `${baseUrl}${prefix}/pass.txt`],
      ["GET", `${baseUrl}/_vinext/publi%63/${secret}/pass.txt`],
      ["GET", `${baseUrl}${prefix}/`],
      ["POST", `${baseUrl}${prefix}/pass.txt`],
    ]) {
      const response = await fetch(url, { method });
      expect(response.status, `${method} ${url}`).toBe(404);
      expect(await response.text()).toBe("");
    }

    const otherPrefix = await fetch(`${baseUrl}/pass.txt`, {
      headers: { "x-vinext-nitro-asset-fallback": "/_vinext/public/0123" },
    });
    expect(otherPrefix.headers.get("x-middleware")).toBe("ran");
    expect(await otherPrefix.text()).toBe("passed through");
  });

  // Next.js serves public/ files by exact path only.
  it("does not serve directory index files from public/", async () => {
    const response = await fetch(`${baseUrl}/docs`);
    expect(response.status).toBe(404);
    expect(await response.text()).toContain("page could not be found");
  });

  it("keeps serving client build output", async () => {
    const html = await (await fetch(baseUrl)).text();
    const chunk = html.match(/src="(\/_next\/static\/chunks\/[^"]+\.js)"/)?.[1];
    expect(chunk).toBeDefined();
    const response = await fetch(`${baseUrl}${chunk}`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toMatch(/javascript/);
  });
});

describe("App Router on Nitro: public files under basePath", () => {
  let root = "";
  let server: ChildProcess | undefined;
  let baseUrl = "";

  beforeAll(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "vinext-nitro-public-base-"));
    await writeFiles(root, {
      "next.config.mjs": `export default { basePath: "/app" };\n`,
      "app/layout.tsx": LAYOUT,
      "app/page.tsx": `export default function Page() { return <p>home</p>; }\n`,
      "public/pass.txt": "passed through",
      "middleware.ts": `import { NextResponse } from "next/server";

export const config = { matcher: ["/pass.txt"] };

export default function middleware() {
  const response = NextResponse.next();
  response.headers.set("x-middleware", "ran");
  return response;
}
`,
    });

    ({ server, baseUrl } = await buildAndStart(root, {}));
    await waitForServer(baseUrl);
  }, 180_000);

  afterAll(async () => {
    await stopServer(server);
    if (root) await fs.rm(root, { recursive: true, force: true });
  });

  it("serves a public file after middleware", async () => {
    const response = await fetch(`${baseUrl}/app/pass.txt`);
    expect(response.status).toBe(200);
    expect(response.headers.get("x-middleware")).toBe("ran");
    expect(await response.text()).toBe("passed through");
  });

  it("does not serve public files outside basePath", async () => {
    const response = await fetch(`${baseUrl}/pass.txt`);
    expect(response.status).toBe(404);
    expect(await response.text()).not.toContain("passed through");
  });
});

describe("App Router on Nitro: public files under a Nitro baseURL without basePath", () => {
  let root = "";
  let server: ChildProcess | undefined;
  let baseUrl = "";

  beforeAll(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "vinext-nitro-public-baseurl-"));
    await writeFiles(root, {
      "app/layout.tsx": LAYOUT,
      "app/page.tsx": `export default function Page() { return <p>home</p>; }\n`,
      "public/file.txt": "nitro base file",
    });

    ({ server, baseUrl } = await buildAndStart(root, { baseURL: "/app/" }));
    await waitForServer(baseUrl);
  }, 180_000);

  afterAll(async () => {
    await stopServer(server);
    if (root) await fs.rm(root, { recursive: true, force: true });
  });

  // vinext's router doesn't strip Nitro's baseURL, so Nitro keeps serving
  // public/ here.
  it("keeps serving public files below the Nitro baseURL", async () => {
    const response = await fetch(`${baseUrl}/app/file.txt`);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("nitro base file");
  });
});

describe("App Router on Nitro: a publicDir set by a later plugin", () => {
  let root = "";
  let server: ChildProcess | undefined;
  let baseUrl = "";

  beforeAll(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "vinext-nitro-public-late-"));
    await writeFiles(root, {
      "app/layout.tsx": LAYOUT,
      "app/page.tsx": `export default function Page() { return <p>home</p>; }\n`,
      "public/file.txt": "nitro public file",
    });

    // Nitro sets up during the config hooks, before this plugin runs.
    const latePublicDir: Plugin = {
      name: "late-public-dir",
      config: () => ({ publicDir: "late-public" }),
    };
    ({ server, baseUrl } = await buildAndStart(root, {}, [latePublicDir]));
    await waitForServer(baseUrl);
  }, 180_000);

  afterAll(async () => {
    await stopServer(server);
    if (root) await fs.rm(root, { recursive: true, force: true });
  });

  // The router serves the resolved publicDir, which Nitro doesn't register,
  // so Nitro keeps serving public/.
  it("keeps serving public/ through Nitro", async () => {
    const response = await fetch(`${baseUrl}/file.txt`);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("nitro public file");
  });
});
