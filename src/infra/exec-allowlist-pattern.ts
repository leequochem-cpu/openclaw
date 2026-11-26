import fs from "node:fs";
import path from "node:path";
import { expandHomePrefix } from "./home-dir.js";

const GLOB_REGEX_CACHE_LIMIT = 512;
const globRegexCache = new Map<string, RegExp>();
// A `.` or `..` path segment. Wildcards must not treat these as ordinary names.
const DOT_PATH_SEGMENT = /(?:^|[/\\])\.{1,2}(?=$|[/\\])/;

function normalizeMatchTarget(value: string): string {
  if (process.platform === "win32") {
    const stripped = value.replace(/^\\\\[?.]\\/, "");
    return stripped.replace(/\\/g, "/").toLowerCase();
  }
  return value.replace(/\\\\/g, "/").toLowerCase();
}

function tryRealpath(value: string): string | null {
  try {
    return fs.realpathSync(value);
  } catch {
    return null;
  }
}

function escapeRegExpLiteral(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeDotPathSegments(value: string): string {
  const normalized =
    process.platform === "win32" ? path.win32.normalize(value) : path.posix.normalize(value);
  return normalizeMatchTarget(normalized);
}

function compileGlobRegex(pattern: string): RegExp {
  const cached = globRegexCache.get(pattern);
  if (cached) {
    return cached;
  }

  let regex = "^";
  let i = 0;
  while (i < pattern.length) {
    const ch = pattern[i];
    if (ch === "*") {
      const next = pattern[i + 1];
      if (next === "*") {
        regex += ".*";
        i += 2;
        continue;
      }
      regex += "[^/]*";
      i += 1;
      continue;
    }
    if (ch === "?") {
      // `?` is one path character, not a separator, so it cannot cross directories.
      regex += "[^/]";
      i += 1;
      continue;
    }
    regex += escapeRegExpLiteral(ch);
    i += 1;
  }
  regex += "$";

  const compiled = new RegExp(regex, "i");
  if (globRegexCache.size >= GLOB_REGEX_CACHE_LIMIT) {
    globRegexCache.clear();
  }
  globRegexCache.set(pattern, compiled);
  return compiled;
}

export function matchesExecAllowlistPattern(pattern: string, target: string): boolean {
  const trimmed = pattern.trim();
  if (!trimmed) {
    return false;
  }

  const expanded = trimmed.startsWith("~") ? expandHomePrefix(trimmed) : trimmed;
  const hasWildcard = /[*?]/.test(expanded);
  let normalizedPattern = expanded;
  let normalizedTarget = target;
  if (process.platform === "win32" && !hasWildcard) {
    normalizedPattern = tryRealpath(expanded) ?? expanded;
    normalizedTarget = tryRealpath(target) ?? target;
  }
  normalizedPattern = normalizeMatchTarget(normalizedPattern);
  normalizedTarget = normalizeMatchTarget(normalizedTarget);
  // Collapse `..` before wildcard matching. Otherwise `/allowed/**` matches
  // `/allowed/../../usr/bin/bash` and allowlist mode auto-approves the escaped binary.
  // Patterns stay raw: normalizing a glob would rewrite intentional `*/..` entries.
  if (hasWildcard && DOT_PATH_SEGMENT.test(normalizedTarget)) {
    normalizedTarget = normalizeDotPathSegments(normalizedTarget);
  }
  return compileGlobRegex(normalizedPattern).test(normalizedTarget);
}
