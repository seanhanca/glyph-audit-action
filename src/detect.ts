import { minimatch } from "minimatch";

export interface ChangedSpec {
  path: string;
}

/**
 * Filter a list of changed file paths down to those that match the spec
 * glob pattern. Pure / side-effect free so it's easy to unit-test.
 */
export function findChangedSpecPairs({
  changedFiles,
  pattern,
}: {
  changedFiles: string[];
  pattern: string;
}): ChangedSpec[] {
  return changedFiles
    .filter((p) => minimatch(p, pattern, { matchBase: false }))
    .map((p) => ({ path: p }));
}
