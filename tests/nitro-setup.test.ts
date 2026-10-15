import { afterEach, describe, expect, it } from "vite-plus/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Plugin } from "vite-plus";
import { routeNitroPublicFilesThroughRouter } from "../packages/vinext/src/build/nitro-public-files.js";
import vinext from "../packages/vinext/src/index.js";

const tempDirs: string[] = [];

type NitroSetupTarget = {
  options: {
    dev?: boolean;
    preset?: string;
    baseURL?: string;
    serveStatic?: boolean | string;
    publicAssets?: { dir: string; baseURL?: string; fallthrough?: boolean }[];
    plugins?: string[];
    virtual?: Record<string, unknown>;
    routeRules?: Record<string, Record<string, unknown>>;
    traceDeps?: string[];
  };
};

type NitroSetupPlugin = {
  nitro?: {
    setup?: (nitro: NitroSetupTarget) => Promise<void> | void;
  };
} & Plugin;

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function isPlugin(plugin: unknown): plugin is Plugin {
  return !!plugin && !Array.isArray(plugin) && typeof plugin === "object" && "name" in plugin;
}

function findNamedPlugin(plugins: ReturnType<typeof vinext>, name: string) {
  return plugins.find((plugin): plugin is Plugin => isPlugin(plugin) && plugin.name === name);
}

function makeTempProject(prefix: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(root);
  fs.writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({ name: "test-project", private: true }, null, 2),
  );
  return root;
}

function writeProjectFile(root: string, relativePath: string, content: string): void {
  const filePath = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

function createAppProject(): string {
  const root = makeTempProject("vinext-nitro-app-");
  writeProjectFile(
    root,
    "app/layout.tsx",
    "export default function RootLayout({ children }: { children: React.ReactNode }) { return <html><body>{children}</body></html>; }\n",
  );
  writeProjectFile(
    root,
    "app/page.tsx",
    "export default function Home() { return <div>home</div>; }\n",
  );
  writeProjectFile(
    root,
    "app/blog/[slug]/page.tsx",
    [
      'import { cookies } from "next/headers";',
      "export const revalidate = 60;",
      "export default async function BlogPage() {",
      '  const session = (await cookies()).get("session")?.value;',
      "  return <div>blog for {session}</div>;",
      "}",
      "",
    ].join("\n"),
  );
  writeProjectFile(
    root,
    "app/isr/page.tsx",
    [
      "export const revalidate = 3600;",
      "export default function IsrPage() {",
      "  return <div>{new Date().toISOString()}</div>;",
      "}",
      "",
    ].join("\n"),
  );
  return root;
}

function createPagesProject(): string {
  const root = makeTempProject("vinext-nitro-pages-");
  writeProjectFile(
    root,
    "pages/index.tsx",
    "export default function Home() { return <div>home</div>; }\n",
  );
  writeProjectFile(
    root,
    "pages/blog/[slug].tsx",
    [
      "export async function getStaticProps() {",
      "  return { props: {}, revalidate: 45 };",
      "}",
      "",
      "export default function BlogPage() {",
      "  return <div>blog</div>;",
      "}",
      "",
    ].join("\n"),
  );
  return root;
}

async function initializeNitroSetupPlugin(
  root: string,
  viteConfig: { publicDir?: string | false } = {},
): Promise<NitroSetupPlugin> {
  const plugins = vinext({ appDir: root, rsc: false }) as ReturnType<typeof vinext>;
  const configPlugin = findNamedPlugin(plugins, "vinext:config") as Plugin & {
    config?: (
      config: { root: string; plugins: unknown[]; publicDir?: string | false },
      env: { command: "build"; mode: string },
    ) => Promise<unknown>;
  };
  if (!configPlugin?.config) {
    throw new Error("vinext:config plugin not found");
  }

  // Passing empty plugins array means hasNitroPlugin=false in the closure,
  // but the nitro.setup hook doesn't gate on hasNitroPlugin (Nitro calls it directly).
  await configPlugin.config(
    { root, plugins: [], ...viteConfig },
    { command: "build", mode: "production" },
  );

  const nitroPlugin = findNamedPlugin(plugins, "vinext:nitro-setup") as NitroSetupPlugin;
  if (!nitroPlugin?.nitro?.setup) {
    throw new Error("vinext:nitro-setup plugin not found");
  }

  return nitroPlugin;
}

describe("vinext Nitro setup integration", () => {
  it("propagates server externals to Nitro traceDeps", async () => {
    const root = createAppProject();
    writeProjectFile(
      root,
      "next.config.mjs",
      `export default { serverExternalPackages: ["custom-apm", "@scope/traced"] };\n`,
    );
    const nitroPlugin = await initializeNitroSetupPlugin(root);
    const nitro = {
      options: {
        dev: false,
        routeRules: {},
        traceDeps: ["existing-trace", "pg"],
      },
    };

    await nitroPlugin.nitro!.setup!(nitro);

    expect(nitro.options.traceDeps?.slice(0, 2)).toEqual(["existing-trace", "pg"]);
    expect(nitro.options.traceDeps).toContain("pg");
    expect(nitro.options.traceDeps).toContain("mongodb");
    expect(nitro.options.traceDeps).toContain("custom-apm");
    expect(nitro.options.traceDeps).toContain("@scope/traced");
    expect(new Set(nitro.options.traceDeps).size).toBe(nitro.options.traceDeps?.length);
  });

  // A path-keyed Nitro response cache cannot see request-time dynamic usage,
  // so a `revalidate` page that reads cookies() would be replayed to other
  // users, and it would bypass vinext's on-demand revalidation even for static
  // ISR pages. vinext's own ISR cache serves both instead.
  it("does not add Nitro cache rules for App Router revalidate routes", async () => {
    const root = createAppProject();
    const nitroPlugin = await initializeNitroSetupPlugin(root);
    const nitro = {
      options: {
        dev: false,
        routeRules: {
          "/blog/*": { headers: { "x-test": "1" } },
        },
      },
    };

    await nitroPlugin.nitro!.setup!(nitro);

    expect(nitro.options.routeRules).toEqual({
      "/blog/*": { headers: { "x-test": "1" } },
    });
  });

  it("does not add Nitro cache rules for Pages Router getStaticProps revalidate routes", async () => {
    const root = createPagesProject();
    const nitroPlugin = await initializeNitroSetupPlugin(root);
    const nitro = { options: { dev: false, routeRules: {} } };

    await nitroPlugin.nitro!.setup!(nitro);

    expect(nitro.options.routeRules).toEqual({});
  });

  it("propagates server externals during Nitro dev", async () => {
    const root = createAppProject();
    const nitroPlugin = await initializeNitroSetupPlugin(root);
    const nitro = {
      options: {
        dev: true,
        routeRules: {},
        traceDeps: ["existing-trace"],
      },
    };

    await nitroPlugin.nitro!.setup!(nitro);

    expect(nitro.options.routeRules).toEqual({});
    expect(nitro.options.traceDeps?.slice(0, 1)).toEqual(["existing-trace"]);
    expect(nitro.options.traceDeps).toContain("pg");
    expect(nitro.options.traceDeps).toContain("mongodb");
  });

  describe("public files", () => {
    function publicFilesNitro(root: string, overrides: Partial<NitroSetupTarget["options"]> = {}) {
      return {
        options: {
          dev: false,
          preset: "node-server",
          serveStatic: true,
          routeRules: {},
          publicAssets: [
            { dir: path.join(root, "public"), baseURL: "/", fallthrough: true },
            { dir: path.join(root, "assets"), baseURL: "/", fallthrough: true },
          ],
          ...overrides,
        },
      };
    }

    // Next.js runs middleware before it serves public/ files, so presets that
    // serve static files in-process hand public/ to vinext's router.
    it("serves public/ under a private prefix on in-process static presets", async () => {
      const root = createAppProject();
      const nitroPlugin = await initializeNitroSetupPlugin(root);
      const nitro = publicFilesNitro(root);

      await nitroPlugin.nitro!.setup!(nitro);

      const [publicDir, otherDir] = nitro.options.publicAssets!;
      expect(publicDir.baseURL).toMatch(/^\/_vinext\/public\/[0-9a-f]{32}$/);
      expect(publicDir.fallthrough).toBe(false);
      expect(otherDir).toEqual({ dir: path.join(root, "assets"), baseURL: "/", fallthrough: true });
      expect(nitro.options.plugins).toEqual(["#vinext/nitro-public-files"]);
      expect(nitro.options.virtual?.["#vinext/nitro-public-files"]).toContain(
        "nitroApp.fetch(request)",
      );

      // A repeated setup keeps the first prefix and plugin registration.
      const prefix = publicDir.baseURL;
      await nitroPlugin.nitro!.setup!(nitro);
      expect(publicDir.baseURL).toBe(prefix);
      expect(nitro.options.plugins).toEqual(["#vinext/nitro-public-files"]);
    });

    it.each([
      ["presets whose platform serves static files", {}, { serveStatic: false }],
      ["AWS Amplify, whose CDN serves static files", {}, { preset: "aws_amplify" }],
      ["dev", {}, { dev: true }],
      ["a disabled Vite publicDir", { publicDir: false as const }, {}],
      ["another Vite publicDir", { publicDir: "static" }, {}],
    ])("leaves public/ with Nitro for %s", async (_name, viteConfig, overrides) => {
      const root = createPagesProject();
      const nitroPlugin = await initializeNitroSetupPlugin(root, viteConfig);
      const nitro = publicFilesNitro(root, overrides);

      await nitroPlugin.nitro!.setup!(nitro);

      expect(nitro.options.publicAssets![0]).toEqual({
        dir: path.join(root, "public"),
        baseURL: "/",
        fallthrough: true,
      });
      expect(nitro.options.plugins).toBeUndefined();
      expect(nitro.options.virtual).toBeUndefined();
    });

    it("includes Nitro's baseURL in the request prefix", () => {
      const publicDir = path.join(os.tmpdir(), "public");
      const options = {
        baseURL: "/app/",
        serveStatic: true,
        publicAssets: [{ dir: publicDir, baseURL: "/", fallthrough: true }],
      };
      const route = (secret: string) =>
        routeNitroPublicFilesThroughRouter(options, { basePath: "/app", publicDir, secret });

      expect(route("abc")).toBe("/app/_vinext/public/abc");
      expect(options.publicAssets[0].baseURL).toBe("/_vinext/public/abc");
      expect(route("def")).toBe("/app/_vinext/public/abc");
    });

    // The router matches public files below basePath, but Nitro passes the
    // path with its own baseURL, so a different baseURL never finds a file.
    it("leaves public/ with Nitro when its baseURL is not the basePath", () => {
      const publicDir = path.join(os.tmpdir(), "public");
      const options = {
        baseURL: "/app/",
        serveStatic: true,
        publicAssets: [{ dir: publicDir, baseURL: "/", fallthrough: true }],
      };

      expect(
        routeNitroPublicFilesThroughRouter(options, { basePath: "", publicDir, secret: "abc" }),
      ).toBeNull();
      expect(options.publicAssets[0]).toEqual({ dir: publicDir, baseURL: "/", fallthrough: true });
    });
  });
});
