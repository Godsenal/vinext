import type { PathToken } from "../utils/path-to-regexp.js";
import { unsafePathTokensReason } from "../utils/path-token-safety.js";
import { analyzeRegexSafety } from "../utils/regex-safety.js";

/**
 * The ReDoS checks config-matchers runs on next.config.js sources and
 * condition regexes. Client builds replace this module with one that accepts
 * every pattern (see plugins/client-config-source-guard.ts), so the analyzer
 * stays out of the browser: the client only matches rules the server checked
 * before publishing them (toClientRedirects, toClientRewrites).
 */

/** Why a compiled source could backtrack catastrophically, or null. */
export function unsafeConfigSourceReason(tokens: PathToken[]): string | null {
  return unsafePathTokensReason(tokens, { ignoreCase: true });
}

/**
 * Whether a regex is safe from catastrophic backtracking. Patterns with the
 * `u` or `v` flag are never vouched for: the analyzer does not model
 * Unicode-mode syntax such as `\p{…}` or `v` class sets.
 */
export function isSafeConfigRegex(pattern: string, flags?: string): boolean {
  if (flags?.includes("u") || flags?.includes("v")) return false;
  return (
    analyzeRegexSafety(pattern, {
      ignoreCase: flags?.includes("i"),
      dotAll: flags?.includes("s"),
      multiline: flags?.includes("m"),
      // A sticky RegExp makes one attempt, at its lastIndex.
      search: !flags?.includes("y"),
    }) === null
  );
}
