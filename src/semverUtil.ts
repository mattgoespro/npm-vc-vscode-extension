import * as semver from "semver";

/**
 * A version spec we can meaningfully compare against a published version.
 * Things like `latest`, `*`, `workspace:*`, git URLs and `file:` specs are not
 * comparable and are reported as such so the analyzer can skip them.
 */
export interface ComparableRange {
  comparable: boolean;
  /** The baseline version implied by the range, when comparable. */
  minVersion?: string;
  /** The leading operator we should preserve when bumping (`^`, `~`, or ''). */
  prefix: string;
}

const RANGE_PREFIX = /^(\^|~|>=|<=|>|<|=|v)?\s*/i;

export function describeRange(range: string): ComparableRange {
  const trimmed = range.trim();

  // Bail out early on specs that are not plain semver ranges.
  if (
    trimmed === "" ||
    trimmed === "*" ||
    trimmed === "latest" ||
    trimmed === "x" ||
    /^(?:https?:|git\+|git:|file:|link:|workspace:|npm:|github:|[\w-]+\/[\w.-]+)/i.test(
      trimmed,
    )
  ) {
    return { comparable: false, prefix: "" };
  }

  let minVersion: semver.SemVer | null = null;
  try {
    minVersion = semver.minVersion(trimmed);
  } catch {
    minVersion = null;
  }
  if (!minVersion) {
    return { comparable: false, prefix: "" };
  }

  const prefixMatch = trimmed.match(/^(\^|~)/);
  const prefix = prefixMatch ? prefixMatch[1] : "";

  return { comparable: true, minVersion: minVersion.version, prefix };
}

/**
 * True when `latest` is a real published version newer than the baseline of the
 * given range. A released version counts as newer than its own prerelease, so a
 * range like `^1.0.0-beta.1` still reports `1.0.0` as an upgrade.
 */
export function isOutdated(range: string, latest: string): boolean {
  const info = describeRange(range);
  if (!info.comparable || !info.minVersion) {
    return false;
  }
  const cleanLatest = semver.valid(latest);
  if (!cleanLatest) {
    return false;
  }
  return semver.gt(cleanLatest, info.minVersion);
}

/**
 * Produce the new range string to write when upgrading, preserving the caret /
 * tilde style the user was already using. Exact pins stay exact.
 */
export function bumpRange(currentRange: string, latest: string): string {
  const trimmed = currentRange.trim();
  const prefixMatch = trimmed.match(RANGE_PREFIX);
  const operator = prefixMatch ? prefixMatch[1] : undefined;

  if (operator === "^" || operator === "~") {
    return `${operator}${latest}`;
  }
  // Exact version, or an operator we don't specifically preserve — pin to latest.
  return latest;
}
