import { parseAst, type Plugin } from "vite";
import { VIRTUAL_MODULE_ID_RE } from "../utils/virtual-module.js";

// Ported from Next.js `assert_client_graph`:
// crates/next-custom-transforms/src/transforms/react_server_components.rs
// `server-only` is on the same list there; vinext validates it separately in
// `vinext:validate-server-only-client-imports`.
const INVALID_CLIENT_IMPORTS: ReadonlySet<string> = new Set(["next/headers", "next/root-params"]);
const INVALID_CLIENT_LIB_APIS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ["next/server", new Set(["after"])],
  [
    "next/cache",
    new Set([
      "revalidatePath",
      "revalidateTag",
      "cacheLife",
      "unstable_cacheLife",
      "cacheTag",
      "unstable_cacheTag",
    ]),
  ],
]);

// An import declaration always spells `import` literally (escaped keywords
// are syntax errors), while its specifier may use escapes such as
// "next\u002fheaders" that only the parsed AST decodes.
const IMPORT_KEYWORD_RE = /\bimport\b/;
// Vite transforms a module loaded with a query (`./x.ts?v=1`) as its file type.
const SOURCE_MODULE_ID_RE = /\.(?:[cm]?tsx?|[cm]?jsx?|mdx)(?:[?#].*)?$/;

type InvalidClientImport = {
  /** The module specifier, or the imported API name for library APIs. */
  name: string;
  start: number;
};

type ModuleItem = ReturnType<typeof parseAst>["body"][number];

function readImportedName(specifier: unknown): string | null {
  if (!specifier || typeof specifier !== "object") return null;
  const node = specifier as {
    type?: string;
    imported?: { type?: string; name?: unknown; value?: unknown };
  };
  if (node.type !== "ImportSpecifier" || !node.imported) return null;
  const name = node.imported.type === "Identifier" ? node.imported.name : node.imported.value;
  return typeof name === "string" ? name : null;
}

/**
 * Whether the module prologue marks a Server Function or cache module. Those
 * are replaced with server reference proxies in the client graph (by
 * @vitejs/plugin-rsc and `vinext:use-cache-callable`, after this check runs),
 * so their imports never reach it; Next.js skips them the same way.
 */
function isServerReferenceModule(body: ModuleItem[]): boolean {
  for (const item of body) {
    if (item.type !== "ExpressionStatement" || typeof item.directive !== "string") return false;
    const directive = item.directive;
    if (
      directive === "use server" ||
      directive === "use cache" ||
      directive.startsWith("use cache: ")
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Find the server-only APIs a module imports, in source order. Like Next.js,
 * only top-level static `import` declarations count, the source must match
 * exactly, library APIs match by imported (not local) name, and `"use server"`
 * and `"use cache"` modules are skipped.
 */
export function findInvalidClientImports(code: string): InvalidClientImport[] {
  if (!IMPORT_KEYWORD_RE.test(code)) return [];

  let body: ModuleItem[];
  try {
    body = parseAst(code).body;
  } catch {
    return [];
  }
  if (isServerReferenceModule(body)) return [];

  const found: InvalidClientImport[] = [];
  for (const item of body) {
    if (item.type !== "ImportDeclaration") continue;
    const source = item.source.value;
    if (typeof source !== "string") continue;

    if (INVALID_CLIENT_IMPORTS.has(source)) {
      found.push({ name: source, start: item.start });
    }

    const invalidApis = INVALID_CLIENT_LIB_APIS.get(source);
    if (!invalidApis) continue;
    for (const specifier of item.specifiers) {
      const imported = readImportedName(specifier);
      if (imported && invalidApis.has(imported)) {
        found.push({ name: imported, start: specifier.start });
      }
    }
  }
  return found;
}

/**
 * Next.js picks the message by whether the importing file's path starts with
 * the app directory (a plain prefix match, as Next.js does).
 */
export function createInvalidClientImportMessage(
  name: string,
  moduleId: string,
  appDir: string,
): string {
  if (moduleId.startsWith(appDir)) {
    return `You're importing a module that depends on "${name}" into a React Client Component module. This API is only available in Server Components but one of its parents is marked with "use client", so this module is also a Client Component.\nLearn more: https://nextjs.org/docs/app/building-your-application/rendering`;
  }
  return `You're importing a module that depends on "${name}". This API is only available in Server Components in the App Router, but you are using it in the Pages Router.\nLearn more: https://nextjs.org/docs/app/building-your-application/rendering/server-components`;
}

type ClientGraphServerApisPluginOptions = {
  /** Canonical, slash-separated App Router directory, or null without one. */
  getAppDir: () => string | null;
};

/**
 * Fail the build when a module in the browser graph imports a request API
 * (`next/headers`, `next/root-params`) or a server-only cache/`after` API,
 * matching Next.js' compile error for modules under a `"use client"`
 * boundary. Those modules are also evaluated during SSR, where module-scope
 * `cookies()` or `headers()` would capture the first request that loads them.
 *
 * Like Next.js, the check needs an App Router and skips `node_modules`. The
 * browser graph is exactly the client layer: it holds every module under a
 * `"use client"` boundary and the Pages Router's page components, but not
 * middleware, instrumentation or Pages data exports, which are stripped first.
 */
export function createClientGraphServerApisPlugin(
  options: ClientGraphServerApisPluginOptions,
): Plugin {
  return {
    name: "vinext:validate-client-graph-server-apis",
    transform: {
      filter: {
        id: {
          include: SOURCE_MODULE_ID_RE,
          exclude: [VIRTUAL_MODULE_ID_RE, /\/node_modules\//],
        },
        code: IMPORT_KEYWORD_RE,
      },
      handler(code, id) {
        if (this.environment?.name !== "client") return null;
        const appDir = options.getAppDir();
        if (!appDir) return null;

        const [invalid] = findInvalidClientImports(code);
        if (!invalid) return null;
        this.error(createInvalidClientImportMessage(invalid.name, id, appDir), invalid.start);
      },
    },
  };
}
