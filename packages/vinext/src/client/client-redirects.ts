import type { NextRedirect, ResolvedNextConfig } from "../config/next-config.js";
import { configRuleCanMatch } from "../config/config-matchers.js";
import {
  isClientHasCondition,
  toClientConditions,
  type ClientHasCondition,
} from "./client-rewrites.js";

type ClientRedirectFields = Pick<NextRedirect, "basePath" | "locale" | "source"> & {
  has?: ClientHasCondition[];
  missing?: ClientHasCondition[];
};

/**
 * Redirect data that is safe to publish in a browser bundle.
 *
 * Next.js keeps redirects in the server routes manifest only. Vinext resolves
 * browser-authoritative redirects during Pages Router navigation, but rules
 * with header or cookie conditions are server-owned: their condition values
 * can be private, so the rule keeps only its source and client-safe
 * conditions to preserve first-match ordering, and drops its destination.
 */
export type ClientRedirect =
  | (ClientRedirectFields & {
      destination: string;
      permanent: boolean;
      requiresServerEvaluation?: never;
    })
  | (ClientRedirectFields & {
      destination?: never;
      permanent?: never;
      requiresServerEvaluation: true;
    });

function toClientRedirect(redirect: NextRedirect): ClientRedirect {
  const hasServerOnlyCondition =
    (redirect.has?.some((condition) => !isClientHasCondition(condition)) ?? false) ||
    (redirect.missing?.some((condition) => !isClientHasCondition(condition)) ?? false);
  const common = {
    source: redirect.source,
    has: toClientConditions(redirect.has),
    missing: toClientConditions(redirect.missing),
    locale: redirect.locale,
    basePath: redirect.basePath,
  };

  if (hasServerOnlyCondition) {
    return { ...common, requiresServerEvaluation: true };
  }

  return { ...common, destination: redirect.destination, permanent: redirect.permanent };
}

/**
 * The redirects to publish to client builds. Client builds do not check
 * regexes for ReDoS, so rules the server never applies, for a skipped source
 * or a rejected has/missing value, are left out without changing which
 * rule matches first.
 */
export function toClientRedirects(redirects: ResolvedNextConfig["redirects"]): ClientRedirect[] {
  return redirects.filter(configRuleCanMatch).map(toClientRedirect);
}
