import {
  analyzeRegexSafety,
  analyzeRegexRepetitionChains,
  analyzeRepeatedRegexAlternatives,
  mayHaveNamedGroups,
  regexAtomsMayOverlap,
  regexExactWidth,
  regexMayConsumeCharacter,
} from "./regex-safety.js";
import { pathTokensToRegExpSource, type PathKey, type PathToken } from "./path-to-regexp.js";

function patternMatches(pattern: string, value: string): boolean {
  try {
    return new RegExp(`^(?:${pattern})$`).test(value);
  } catch {
    return false;
  }
}

function atomsOverlap(left: string, right: string): boolean {
  return regexAtomsMayOverlap(left, right, true);
}

function groupCanMatchEmpty(group: string): boolean {
  if (/^\?(?:[=!]|<[=!])/.test(group)) return true;
  const body = group.startsWith("?:") ? group.slice(2) : group;
  return patternMatches(body, "");
}

function hasOverlappingSequentialRepetition(pattern: string): boolean {
  const repeatedAtDepth: string[][] = [[]];
  const groupStarts: number[] = [];
  let depth = 0;

  for (let index = 0; index < pattern.length; index++) {
    const character = pattern[index];
    if (character === "(") {
      groupStarts.push(index);
      depth++;
      repeatedAtDepth[depth] = [];
      if (pattern[index + 1] === "?") {
        // Skip the non-capturing/lookaround marker. Its punctuation is not a
        // consuming atom, and the existing validator handles quantified
        // lookaround groups conservatively.
        index++;
        if (pattern[index + 1] === "<" && /[=!]/.test(pattern[index + 2] ?? "")) index += 2;
        else if (/[=:!]/.test(pattern[index + 1] ?? "")) index++;
      }
      continue;
    }
    if (character === ")") {
      const groupStart = groupStarts.pop();
      repeatedAtDepth[depth] = [];
      depth = Math.max(0, depth - 1);
      if (groupStart !== undefined) {
        const modifier = pattern[index + 1];
        const optionalModifier =
          modifier === "*" ||
          modifier === "?" ||
          (modifier === "{" && /^\{0(?:,\d*)?\}/.test(pattern.slice(index + 1)));
        if (!optionalModifier && !groupCanMatchEmpty(pattern.slice(groupStart + 1, index))) {
          repeatedAtDepth[depth] = [];
        }
      }
      continue;
    }
    if (character === "|") {
      repeatedAtDepth[depth] = [];
      continue;
    }
    if (character === "^" || character === "$") continue;
    if (character === "*" || character === "+" || character === "?" || character === "{") {
      continue;
    }

    let atom = character;
    if (character === "\\") {
      if (index + 1 >= pattern.length) return true;
      atom += pattern[++index];
    } else if (character === "[") {
      let classEnd = index + 1;
      if (pattern[classEnd] === "^") classEnd++;
      while (classEnd < pattern.length && pattern[classEnd] !== "]") {
        if (pattern[classEnd] === "\\") classEnd++;
        classEnd++;
      }
      if (classEnd >= pattern.length) return true;
      atom = pattern.slice(index, classEnd + 1);
      index = classEnd;
    } else if (character === ".") {
      atom = ".";
    }

    const quantifierStart = index + 1;
    const quantifier = pattern[quantifierStart];
    let unbounded = quantifier === "*" || quantifier === "+";
    let canBeEmpty = quantifier === "*";
    let quantifierEnd = quantifierStart;
    if (quantifier === "{") {
      const match = /^\{(\d+),\}/.exec(pattern.slice(quantifierStart));
      if (match) {
        unbounded = true;
        canBeEmpty = Number(match[1]) === 0;
        quantifierEnd += match[0].length - 1;
      }
    }

    if (!unbounded) {
      // An optional atom does not separate the repetitions on either side;
      // every other non-repeated atom is a mandatory separator.
      if (quantifier !== "?") repeatedAtDepth[depth] = [];
      if (quantifier === "?") index = quantifierStart;
      continue;
    }

    if (repeatedAtDepth[depth].some((previous) => atomsOverlap(previous, atom))) {
      return true;
    }
    repeatedAtDepth[depth] = canBeEmpty ? [...repeatedAtDepth[depth], atom] : [atom];
    index = quantifierEnd;
  }

  return false;
}

export type PathTokenSafetyOptions = {
  /**
   * Whether the compiled RegExp uses the `i` flag. The per-pattern checks
   * stay case-insensitive, which only makes them more conservative.
   */
  ignoreCase: boolean;
};

function unsafeTokenReason(
  token: PathKey,
  namedGroups: boolean,
  options: PathTokenSafetyOptions,
): string | null {
  const regexSafetyIssue = analyzeRegexSafety(token.pattern, { ignoreCase: true, namedGroups });
  if (regexSafetyIssue) {
    if (regexSafetyIssue === "analysis budget exceeded") {
      return `parameter "${token.name}" exceeds the regex analysis budget`;
    }
    return `parameter "${token.name}" contains ${regexSafetyIssue}`;
  }
  if (hasOverlappingSequentialRepetition(token.pattern)) {
    return `parameter "${token.name}" contains overlapping sequential repetition`;
  }

  if (token.modifier !== "*" && token.modifier !== "+") return null;

  // The pattern repeats once per segment, so its alternatives must not match
  // the same text: `/:id(a|aa?)+` has two ways to match each "a" segment.
  const alternativesIssue = analyzeRepeatedRegexAlternatives(token.pattern, {
    ignoreCase: true,
    namedGroups,
  });
  if (alternativesIssue === "analysis budget exceeded") {
    return `parameter "${token.name}" exceeds the regex analysis budget`;
  }
  if (alternativesIssue) return `repeated parameter "${token.name}" contains ${alternativesIssue}`;

  // A fixed-width P splits its repeats by input length alone, so neither
  // check below applies to it (width zero is the empty-value case).
  const width = regexExactWidth(token.pattern, { namedGroups });
  if (width === 0) {
    return `repeated parameter "${token.name}" may match an empty value or path delimiter`;
  }
  if (width !== null) return null;

  // Repeating parameters are joined by the token prefix/suffix. If their own
  // constraint can also consume a slash (or the empty string), the same input
  // has many equivalent partitions. Patterns such as `/:path(.*)*/end` then
  // backtrack exponentially on a near miss. Ordinary repeats use a constraint
  // that cannot cross the path delimiter, so each segment has one owner.
  if (patternMatches(token.pattern, "") || patternMatches(token.pattern, "/")) {
    return `repeated parameter "${token.name}" may match an empty value or path delimiter`;
  }
  // The repeats compile to `P(?:SP)*` with separator S = suffix + prefix.
  // If P can never consume S's first code unit, every P ends right where the
  // next S begins, so the split is unique; likewise for S's last code unit
  // read from the right. Only when P can consume both may it take part of S,
  // as in `/{a:id(a+)}*X`. Code units, since the RegExp has no `u` flag.
  const separator = token.suffix + token.prefix;
  if (separator !== "") {
    const mayConsume = (character: string) =>
      regexMayConsumeCharacter(token.pattern, character, {
        ignoreCase: options.ignoreCase,
        namedGroups,
      });
    if (mayConsume(separator[0]!) && mayConsume(separator[separator.length - 1]!)) {
      return `repeated parameter "${token.name}" may match part of its own separator`;
    }
  }

  return null;
}

/**
 * Reject path-to-regexp tokens whose custom patterns can backtrack
 * catastrophically once compiled. Each param's pattern and how it repeats are
 * checked, then the sequence of params in the compiled RegExp, so adjacent
 * params such as `/:a(a+):b(a+):c(a+)` cannot form an overlapping chain.
 */
export function unsafePathTokensReason(
  tokens: PathToken[],
  options: PathTokenSafetyOptions,
): string | null {
  // Every token pattern is compiled into one RegExp, so a named group in any
  // of them turns `\k<name>` in another into a backreference.
  const namedGroups = tokens.some(
    (token) => typeof token !== "string" && mayHaveNamedGroups(token.pattern),
  );
  for (const token of tokens) {
    if (typeof token === "string") continue;
    const reason = unsafeTokenReason(token, namedGroups, options);
    if (reason) return reason;
  }
  // Each param was checked above; a chain of overlapping repeats can still
  // span params. Tokens that do not compile yet are checked again by the
  // caller once normalized, or rejected as invalid.
  let source: string;
  try {
    source = pathTokensToRegExpSource(tokens);
  } catch {
    return null;
  }
  const sequenceIssue = analyzeRegexRepetitionChains(source, {
    ignoreCase: options.ignoreCase,
    namedGroups,
  });
  if (sequenceIssue === "analysis budget exceeded")
    return "source exceeds the regex analysis budget";
  if (sequenceIssue) return `source contains ${sequenceIssue}`;
  return null;
}
