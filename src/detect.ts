import { minimatch } from "minimatch";

/**
 * One spec file. v0.1.0 carried only the path; the wrapper exists so
 * future fields (e.g. `baseSha`, `headSha`) can be added without
 * breaking call sites.
 */
export interface ChangedSpec {
  path: string;
}

/**
 * Filter a list of changed file paths down to those that match the spec
 * glob pattern. Pure / side-effect free so it's easy to unit-test.
 *
 * v0.2 NOTE: the action no longer drives off `pulls.listFiles` (that
 * silently dropped new specs). `findChangedSpecs` is kept as a helper
 * for callers that legitimately want a CHANGED-files view, but `main.ts`
 * uses the broader `matchesPattern` against every spec at HEAD.
 */
export function findChangedSpecs({
  changedFiles,
  pattern,
}: {
  changedFiles: string[];
  pattern: string;
}): ChangedSpec[] {
  return changedFiles.filter((p) => matchesPattern(p, pattern)).map((p) => ({ path: p }));
}

/** Single-path matcher — used by main.ts when filtering the git tree. */
export function matchesPattern(path: string, pattern: string): boolean {
  return minimatch(path, pattern);
}
