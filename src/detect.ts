import { minimatch } from "minimatch";

/**
 * One spec file that changed on a PR. PR3 will widen this to include
 * `baseSha` / `headSha` (so render.ts can fetch both versions and produce
 * a before/after image) — the object wrapper exists today specifically so
 * those fields can be added without breaking call sites.
 */
export interface ChangedSpec {
  path: string;
}

/**
 * Filter a list of changed file paths down to those that match the spec
 * glob pattern. Pure / side-effect free so it's easy to unit-test.
 */
export function findChangedSpecs({
  changedFiles,
  pattern,
}: {
  changedFiles: string[];
  pattern: string;
}): ChangedSpec[] {
  return changedFiles.filter((p) => minimatch(p, pattern)).map((p) => ({ path: p }));
}
