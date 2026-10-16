/**
 * Synchronous fast path for matching next.config.js sources during Pages
 * client navigation, without loading config-matchers.
 *
 * It must agree exactly with the server matcher (path-to-regexp, case-
 * insensitive, optional trailing slash), so it only handles sources built
 * from whole-segment literals, `:name` segments and a final `:name*` or
 * `:name+`. Any other source returns `undefined` so the caller defers to the
 * exact async matcher.
 */

// Whole-segment literals path-to-regexp reads as plain text.
const LITERAL_SEGMENT_RE = /^[A-Za-z0-9_~.%@!$&',;=-]+$/;
const PARAM_SEGMENT_RE = /^:(\w+)$/;
const CATCH_ALL_SEGMENT_RE = /^:(\w+)([*+])$/;

function asciiLowerCase(value: string): string {
  return value.replace(/[A-Z]/g, (character) => character.toLowerCase());
}

function isAscii(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    if (value.charCodeAt(index) > 0x7f) return false;
  }
  return true;
}

function stripOneTrailingSlash(pathname: string): string {
  return pathname.length > 1 && pathname.endsWith("/") ? pathname.slice(0, -1) : pathname;
}

/**
 * Match `pathname` against `source`. Returns the params, `null` when the
 * source cannot match, or `undefined` when the source is outside the shapes
 * this fast path models.
 */
export function matchSimpleClientConfigSource(
  pathname: string,
  source: string,
): Record<string, string> | null | undefined {
  if (!source.startsWith("/") || pathname.includes("//")) return undefined;
  // The compiled source accepts one optional trailing slash on the pathname.
  const path = stripOneTrailingSlash(pathname);
  if (source === "/") return path === "/" ? Object.create(null) : null;

  const sourceParts = source.split("/");
  const pathParts = path.split("/");
  // Null prototype, so a `:__proto__` param is stored as an own value.
  const params: Record<string, string> = Object.create(null);

  for (let index = 1; index < sourceParts.length; index++) {
    const sourcePart = sourceParts[index]!;
    const pathPart = pathParts[index];

    const catchAll = CATCH_ALL_SEGMENT_RE.exec(sourcePart);
    if (catchAll) {
      if (index !== sourceParts.length - 1) return undefined;
      const rest = pathParts.slice(index).join("/");
      if (catchAll[2] === "+" && rest === "") return null;
      // An empty `*` is an unmatched param to the exact matcher, which then
      // may append the other params to the rewrite query.
      if (rest === "") return undefined;
      // Duplicate names keep the last capture that matched; leave them to
      // the exact matcher.
      if (catchAll[1]! in params) return undefined;
      params[catchAll[1]!] = rest;
      return params;
    }

    const param = PARAM_SEGMENT_RE.exec(sourcePart);
    if (param) {
      if (pathPart === undefined || pathPart === "") return null;
      if (param[1]! in params) return undefined;
      params[param[1]!] = pathPart;
      continue;
    }

    // Also rejects an empty segment, so a slash-ending source defers.
    if (!LITERAL_SEGMENT_RE.test(sourcePart)) return undefined;
    // ASCII-only folding: a case-insensitive RegExp without the `u` flag never
    // matches a non-ASCII character against an ASCII literal.
    if (pathPart === undefined || asciiLowerCase(pathPart) !== asciiLowerCase(sourcePart)) {
      return null;
    }
  }

  return pathParts.length === sourceParts.length ? params : null;
}

/**
 * Whether a rewrite to `destination` appends the source `params` to its
 * query. Next.js does that when the destination's path, host and hash use
 * none of them, for each param its query does not already name; the sync
 * path does not, so it defers these rewrites.
 */
export function clientRewriteAppendsParams(
  destination: string,
  params: Record<string, string>,
): boolean {
  // Like the server, the i18n locale param never triggers the append.
  const keys = Object.keys(params).filter((key) => key !== "nextInternalLocale");
  if (keys.length === 0) return false;
  const hashIndex = destination.indexOf("#");
  const beforeHash = hashIndex === -1 ? destination : destination.slice(0, hashIndex);
  const queryIndex = beforeHash.indexOf("?");
  const withoutQuery =
    (queryIndex === -1 ? beforeHash : beforeHash.slice(0, queryIndex)) +
    (hashIndex === -1 ? "" : destination.slice(hashIndex));
  // Fast-path param names are `\w+`, so they need no escaping.
  if (keys.some((key) => new RegExp(`:${key}(?![A-Za-z0-9_])`).test(withoutQuery))) return false;
  const queryKeys = new Set(
    queryIndex === -1 ? [] : new URLSearchParams(beforeHash.slice(queryIndex + 1)).keys(),
  );
  return keys.some((key) => !queryKeys.has(key));
}

/**
 * Cheap pre-check: false only when `source` can never match `pathname`.
 * Every match starts with the source's literal text up to its first param,
 * group or escape, minus a trailing `/` or `.` that may be an optional
 * param's prefix.
 */
export function clientConfigSourceCouldMatch(pathname: string, source: string): boolean {
  const wildcardIndex = source.search(/[:(\\{*+?]/);
  let literalPrefix = wildcardIndex === -1 ? source : source.slice(0, wildcardIndex);
  if (wildcardIndex !== -1 && /[/.]$/.test(literalPrefix)) {
    literalPrefix = literalPrefix.slice(0, -1);
  }
  // A literal source matches with one trailing slash too.
  literalPrefix = stripOneTrailingSlash(literalPrefix);
  if (literalPrefix === "/") return true;
  if (!isAscii(literalPrefix)) return true;
  return asciiLowerCase(pathname).startsWith(asciiLowerCase(literalPrefix));
}
