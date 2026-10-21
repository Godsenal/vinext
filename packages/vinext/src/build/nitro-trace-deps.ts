import path from "pathslash";
import { escapeRegExp } from "../utils/regex.js";
import { readJsonFile } from "../utils/safe-json-file.js";

export type NitroTraceDep = string | RegExp;

// The RegExps `mergeNitroTraceDeps` added, so a later merge can replace them.
const addedPatterns = new WeakSet<RegExp>();

type PackageJson = {
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
};

/**
 * Package names Nitro should copy into its output even when no import of them
 * is seen, if they are also server externals: the ones the app lists in
 * `serverExternalPackages` or depends on at runtime (`dependencies` /
 * `optionalDependencies`).
 *
 * Nitro only sees ES imports. A `require()` of an external from bundled
 * CommonJS code reaches it as a call on `createRequire(import.meta.url)`, and
 * an APM agent loaded with `node --import` / `-r` is never imported at all.
 */
export function resolveAlwaysTracedPackageNames(
  root: string,
  userServerExternalPackages: readonly string[],
): Set<string> {
  const pkg = readJsonFile<PackageJson>(path.join(root, "package.json"));
  return new Set([
    ...userServerExternalPackages,
    ...Object.keys({ ...pkg?.dependencies, ...pkg?.optionalDependencies }),
  ]);
}

/**
 * Adds the server external packages to Nitro's `traceDeps`, so an imported
 * external stays a bare `node_modules` import in the Nitro output instead of
 * being bundled into `_libs`.
 *
 * Nitro copies every package named by a string entry into the output, whether
 * the server imports it or not (nitrojs/nitro#4391). That would ship every
 * installed default external (`typescript`, `webpack`, `playwright`, ...), so
 * only `alwaysTraced` names are added as strings. The rest are added as a
 * RegExp, which only marks matching imports as traced externals, the way
 * Next.js output file tracing copies just the externals the server imports.
 * Each name is matched exactly, the same as a string entry.
 *
 * Names already listed as a string (including a `!name` opt-out, which Nitro
 * only applies to strings) are left to that entry, so this must run after
 * every Nitro module has set up its `traceDeps`. A later `!name` can't cancel
 * a RegExp, so the RegExps an earlier merge added are dropped and recomputed.
 */
export function mergeNitroTraceDeps(
  traceDeps: readonly NitroTraceDep[] | undefined,
  serverExternalPackages: readonly string[],
  alwaysTraced: ReadonlySet<string>,
): NitroTraceDep[] {
  const existing = (traceDeps ?? []).filter(
    (dep) => !(dep instanceof RegExp && addedPatterns.has(dep)),
  );
  // Same selector order as Nitro: `!pkg*` negates the literal `pkg*`, not `pkg`.
  const userNames = new Set(
    existing
      .filter((dep): dep is string => typeof dep === "string")
      .map((dep) => (dep.startsWith("!") ? dep.slice(1) : dep.replace(/\*$/, ""))),
  );
  const patterns = new Set(
    existing.filter((dep): dep is RegExp => dep instanceof RegExp).map((dep) => dep.source),
  );
  const added = [...new Set(serverExternalPackages)]
    .filter((name) => !userNames.has(name))
    .map((name) => (alwaysTraced.has(name) ? name : new RegExp(escapeRegExp(name))))
    .filter((dep) => typeof dep === "string" || !patterns.has(dep.source));
  for (const dep of added) {
    if (dep instanceof RegExp) addedPatterns.add(dep);
  }
  return [...existing, ...added];
}
