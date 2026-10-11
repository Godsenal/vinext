import { toSlash } from "pathslash";
import { parseAst, type Plugin } from "vite";
import { stripViteModuleQuery } from "../utils/path.js";
import { isServerEnvironment } from "./environment.js";

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

// Every checked specifier is a string literal starting with "next/", unless
// it is spelled with escapes ("next\u002fheaders", "next\/headers") that only
// the parsed AST decodes; any escape needs a backslash. The quote matters:
// paths such as dev JSX `fileName`s often contain "vinext/".
const SERVER_API_CANDIDATE_RE = /["']next\/|\\/;
const USE_CLIENT_CANDIDATE_RE = /\buse client\b/;
const CANDIDATE_MODULE_RE = /["']next\/|\\|\buse client\b/;

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

function hasDirective(body: ModuleItem[], matches: (directive: string) => boolean): boolean {
  for (const item of body) {
    if (item.type !== "ExpressionStatement" || typeof item.directive !== "string") return false;
    if (matches(item.directive)) return true;
  }
  return false;
}

type ClientGraphModuleInfo = {
  /** Whether the module starts a `"use client"` boundary. */
  isClientBoundary: boolean;
  /** Whether the module has a module-level `"use server"` or `"use cache"` directive. */
  isServerModule: boolean;
  invalidImports: InvalidClientImport[];
};

/**
 * Runs on final module code. Server Function and cache modules (which Next.js
 * skips) need no exemption: @vitejs/plugin-rsc and `vinext:use-cache-callable`
 * have already replaced them with server reference proxies that keep none of
 * their imports, while one they did not replace (in a Web Worker bundle, a
 * virtual module, or added by a later plugin) still reaches the browser.
 */
function analyzeClientGraphModule(code: string): ClientGraphModuleInfo {
  const none: ClientGraphModuleInfo = {
    isClientBoundary: false,
    isServerModule: false,
    invalidImports: [],
  };
  if (!CANDIDATE_MODULE_RE.test(code)) return none;

  let body: ModuleItem[];
  try {
    body = parseAst(code).body;
  } catch {
    return none;
  }
  const invalidImports: InvalidClientImport[] = [];
  for (const item of body) {
    if (item.type !== "ImportDeclaration") continue;
    const source = item.source.value;
    if (typeof source !== "string") continue;

    if (INVALID_CLIENT_IMPORTS.has(source)) {
      invalidImports.push({ name: source, start: item.start });
    }

    const invalidApis = INVALID_CLIENT_LIB_APIS.get(source);
    if (!invalidApis) continue;
    for (const specifier of item.specifiers) {
      const imported = readImportedName(specifier);
      if (imported && invalidApis.has(imported)) {
        invalidImports.push({ name: imported, start: specifier.start });
      }
    }
  }
  return {
    isClientBoundary: hasDirective(body, (directive) => directive === "use client"),
    isServerModule: hasDirective(
      body,
      (directive) => directive === "use server" || directive.startsWith("use cache"),
    ),
    invalidImports,
  };
}

/**
 * Find the server-only APIs a module imports, in source order. Like Next.js,
 * only top-level static `import` declarations count, the source must match
 * exactly, and library APIs match by imported (not local) name.
 */
export function findInvalidClientImports(code: string): InvalidClientImport[] {
  return analyzeClientGraphModule(code).invalidImports;
}

/**
 * Next.js picks the message by whether the importing file's path starts with
 * the app directory (a plain prefix match, as Next.js does).
 */
export function createInvalidClientImportMessage(
  name: string,
  moduleId: string,
  appDir: string | null,
): string {
  if (appDir && moduleId.startsWith(appDir)) {
    return `You're importing a module that depends on "${name}" into a React Client Component module. This API is only available in Server Components but one of its parents is marked with "use client", so this module is also a Client Component.\nLearn more: https://nextjs.org/docs/app/building-your-application/rendering`;
  }
  return `You're importing a module that depends on "${name}". This API is only available in Server Components in the App Router, but you are using it in the Pages Router.\nLearn more: https://nextjs.org/docs/app/building-your-application/rendering/server-components`;
}

type ClientGraphServerApisPluginOptions = {
  /** Canonical, slash-separated App Router directory, or null without one. */
  getAppDir: () => string | null;
  /**
   * Slash-separated file paths of the Pages Router's pages (not API routes)
   * and its root `_app`, `_document` and `_error`, as the router scanned them.
   */
  getPagesPages?: () => Promise<ReadonlySet<string>>;
  /** The generated module that imports the Pages Router's pages. */
  pagesEntryId?: string;
  /**
   * For a browser Web Worker's plugin container (`worker.plugins`). Vite
   * bundles every worker separately, and a worker is browser code throughout.
   */
  worker?: boolean;
};

/** Whether `id` is, or is imported (at any depth) by, a client-layer root. */
function isReachableFromClientRoot(
  id: string,
  isClientRoot: (id: string) => boolean,
  getImporters: (id: string) => Iterable<string>,
): boolean {
  const seen = new Set<string>();
  const pending = [id];
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    if (seen.has(next)) continue;
    seen.add(next);
    if (isClientRoot(next)) return true;
    pending.push(...getImporters(next));
  }
  return false;
}

type ServerGraphState = {
  /** Modules opening a "use client" boundary. */
  clientBoundaries: Set<string>;
  /** Modules importing a server API, resolved against the graph at buildEnd. */
  invalidImports: Map<string, InvalidClientImport>;
};

type GraphKind = "browser" | "server";

/**
 * The browser graph is client layer throughout. The RSC environment is the
 * react-server layer, which Next.js checks differently. Every other server
 * environment (SSR, or the Worker or Node environment rendering Pages
 * Router pages) mixes client-layer modules with middleware, instrumentation
 * and API routes.
 */
function getGraphKind(
  environment: { name: string; config: { consumer?: string } } | undefined,
  hasAppDir: boolean,
): GraphKind | null {
  if (!environment) return null;
  if (environment.name === "client") return "browser";
  if (!isServerEnvironment(environment)) return null;
  if (hasAppDir && environment.name === "rsc") return null;
  return "server";
}

/**
 * Fail the build when a module in the client layer imports a request API
 * (`next/headers`, `next/root-params`) or a server-only cache/`after` API,
 * matching Next.js' compile error. Client-layer modules are evaluated during
 * SSR, where module-scope `cookies()` or `headers()` would capture the first
 * request that loads them.
 *
 * Like Next.js, the check skips `node_modules`.
 *
 * - The browser graph (and every Web Worker bundle) is client layer
 *   throughout: every module under a `"use client"` boundary plus the Pages
 *   Router's page components, without middleware, instrumentation or Pages
 *   data exports, which are stripped first.
 * - A server graph (SSR, or the environment rendering Pages Router pages)
 *   also holds middleware, instrumentation and API routes, so there a module
 *   is checked only when a `"use client"` module or a Pages Router page
 *   (including `_app`, `_document` and `_error`) imports it, directly or not.
 *   That includes modules only Pages data exports use, and modules that
 *   resolution conditions such as `browser` keep out of the browser graph.
 */
export function createClientGraphServerApisPlugin(
  options: ClientGraphServerApisPluginOptions,
): Plugin {
  const serverGraphs = new Map<string, ServerGraphState>();
  const getServerGraph = (environmentName: string): ServerGraphState => {
    let state = serverGraphs.get(environmentName);
    if (!state) {
      state = { clientBoundaries: new Set(), invalidImports: new Map() };
      serverGraphs.set(environmentName, state);
    }
    return state;
  };
  // Pages pages open the client layer in every server graph. A "use client"
  // module only does in App Router SSR: Pages-only apps have no Client
  // Components, so there an inert directive in a module that only an API
  // route or middleware imports (graphs Next.js leaves unchecked) is ignored.
  // Pages are matched by the exact ids the generated Pages entry imports them
  // under in this environment, which follow `resolve.alias` and
  // `resolve.preserveSymlinks`.
  const getClientRootPredicate = async (
    graph: ServerGraphState,
    hasAppDir: boolean,
    resolve: (source: string, importer?: string) => Promise<{ id: string } | null>,
  ): Promise<(moduleId: string) => boolean> => {
    const pagesPages = (await options.getPagesPages?.()) ?? new Set<string>();
    const pageIds = new Set<string>();
    await Promise.all(
      [...pagesPages].map(async (pagePath) => {
        const resolved = await resolve(pagePath, options.pagesEntryId);
        pageIds.add(resolved?.id ?? pagePath);
      }),
    );
    return (moduleId) =>
      (hasAppDir && graph.clientBoundaries.has(moduleId)) || pageIds.has(moduleId);
  };

  return {
    name: "vinext:validate-client-graph-server-apis",
    // Check the final module code, after every other plugin's transform (an
    // app plugin may add imports), but before Vite's dev import analysis
    // rewrites specifiers.
    enforce: "post",
    buildStart() {
      const environment = this.environment;
      if (getGraphKind(environment, options.getAppDir() !== null) !== "server") return;
      serverGraphs.delete(environment.name);
    },
    // A module that loses its "use client" directive may no longer match the
    // code filter, so drop its boundaries (under any query) when the file
    // changes; the next transform adds them back if the directive is still
    // there.
    watchChange(id) {
      const file = toSlash(id);
      for (const graph of serverGraphs.values()) {
        for (const boundary of graph.clientBoundaries) {
          if (stripViteModuleQuery(boundary) === file) graph.clientBoundaries.delete(boundary);
        }
      }
    },
    transform: {
      // Any module id: plugins may serve JavaScript under virtual or
      // extensionless ids, and code that does not parse is skipped. vinext's
      // own virtual modules only import request APIs in the RSC entry.
      filter: {
        id: { exclude: /\/node_modules\// },
        code: CANDIDATE_MODULE_RE,
      },
      async handler(code, id) {
        const environment = this.environment;
        const appDir = options.getAppDir();
        const graphKind = options.worker ? "browser" : getGraphKind(environment, appDir !== null);
        if (!graphKind) return null;
        // Only App Router server graphs track "use client" boundaries.
        const tracksBoundaries = graphKind === "server" && appDir !== null;
        if (
          !SERVER_API_CANDIDATE_RE.test(code) &&
          !(tracksBoundaries && USE_CLIENT_CANDIDATE_RE.test(code))
        ) {
          return null;
        }

        const { isClientBoundary, isServerModule, invalidImports } = analyzeClientGraphModule(code);
        // Like Next.js, skip Server Function and cache modules. With an App
        // Router, any that reach here were not replaced by server reference
        // proxies, so they are checked; Pages-only apps never replace them.
        if (appDir === null && isServerModule) return null;
        const [invalid] = invalidImports;
        if (graphKind === "browser") {
          if (invalid) {
            this.error(createInvalidClientImportMessage(invalid.name, id, appDir), invalid.start);
          }
          return null;
        }

        const graph = getServerGraph(environment.name);
        if (isClientBoundary) graph.clientBoundaries.add(id);
        else graph.clientBoundaries.delete(id);
        if (!invalid) return null;
        if (environment.mode === "build") {
          graph.invalidImports.set(id, invalid);
          return null;
        }
        if (environment.mode !== "dev") return null;
        // In dev the importer that triggered this load is already in the graph.
        const getImporters = (moduleId: string) => {
          const importers: string[] = [];
          for (const importer of environment.moduleGraph.getModuleById(moduleId)?.importers ?? []) {
            if (importer.id) importers.push(importer.id);
          }
          return importers;
        };
        const isClientRoot = await getClientRootPredicate(
          graph,
          appDir !== null,
          (source, importer) => this.resolve(source, importer),
        );
        if (isReachableFromClientRoot(id, isClientRoot, getImporters)) {
          this.error(createInvalidClientImportMessage(invalid.name, id, appDir), invalid.start);
        }
        return null;
      },
    },
    async buildEnd() {
      const environment = this.environment;
      const graph = environment ? serverGraphs.get(environment.name) : undefined;
      if (!graph || graph.invalidImports.size === 0) return;
      const appDir = options.getAppDir();
      const getImporters = (moduleId: string) => {
        const info = this.getModuleInfo(moduleId);
        return info ? [...info.importers, ...info.dynamicImporters] : [];
      };
      const isClientRoot = await getClientRootPredicate(
        graph,
        appDir !== null,
        (source, importer) => this.resolve(source, importer),
      );
      for (const [id, invalid] of graph.invalidImports) {
        if (isReachableFromClientRoot(id, isClientRoot, getImporters)) {
          this.error({ id, message: createInvalidClientImportMessage(invalid.name, id, appDir) });
        }
      }
    },
  };
}
