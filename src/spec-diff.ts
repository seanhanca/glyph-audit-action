/**
 * Spec diff — vendored from `@glyph/core/spec-diff` for v0.2.
 *
 * Pure-fn structural diff between two Glyph specs (anything JSON-shaped,
 * really). Returns added / removed / changed paths plus a one-sentence
 * narrative summary.
 *
 * Used by `main.ts` when a spec exists at BOTH base and head SHAs (i.e.
 * an edit, not a new-file). New specs skip the diff and surface the
 * audit findings directly.
 */

export interface SpecDiffChange {
  /** RFC 6901 JSON pointer to the changed value. */
  readonly path: string;
  readonly before: unknown;
  readonly after: unknown;
}

export interface SpecDiffEntry {
  readonly path: string;
  readonly value: unknown;
}

export interface SpecDiff {
  readonly added: ReadonlyArray<SpecDiffEntry>;
  readonly removed: ReadonlyArray<SpecDiffEntry>;
  readonly changed: ReadonlyArray<SpecDiffChange>;
  /** One-sentence narrative; "" when the specs are identical. */
  readonly summary: string;
}

/** Compute a structural diff between two Glyph specs. */
export function diffSpecs(a: unknown, b: unknown): SpecDiff {
  const added: SpecDiffEntry[] = [];
  const removed: SpecDiffEntry[] = [];
  const changed: SpecDiffChange[] = [];
  walk(a, b, "", added, removed, changed);
  const summary = buildSummary(added, removed, changed);
  return { added, removed, changed, summary };
}

function walk(
  a: unknown,
  b: unknown,
  path: string,
  added: SpecDiffEntry[],
  removed: SpecDiffEntry[],
  changed: SpecDiffChange[],
): void {
  if (a === b) return;
  if (isObject(a) && isObject(b)) {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const k of keys) {
      const childPath = `${path}/${escapePointer(k)}`;
      const av = (a as Record<string, unknown>)[k];
      const bv = (b as Record<string, unknown>)[k];
      if (av === undefined && bv !== undefined) {
        added.push({ path: childPath, value: bv });
      } else if (av !== undefined && bv === undefined) {
        removed.push({ path: childPath, value: av });
      } else {
        walk(av, bv, childPath, added, removed, changed);
      }
    }
    return;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    const max = Math.max(a.length, b.length);
    for (let i = 0; i < max; i++) {
      const childPath = `${path}/${i}`;
      if (i >= a.length) added.push({ path: childPath, value: b[i] });
      else if (i >= b.length) removed.push({ path: childPath, value: a[i] });
      else walk(a[i], b[i], childPath, added, removed, changed);
    }
    return;
  }
  if (!deepEqual(a, b)) {
    changed.push({ path: path || "/", before: a, after: b });
  }
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!deepEqual(a[i], b[i])) return false;
    }
    return true;
  }
  if (isObject(a) && isObject(b)) {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const k of keys) {
      if (!deepEqual(a[k], b[k])) return false;
    }
    return true;
  }
  return false;
}

function escapePointer(s: string): string {
  return s.replace(/~/g, "~0").replace(/\//g, "~1");
}

function buildSummary(
  added: ReadonlyArray<SpecDiffEntry>,
  removed: ReadonlyArray<SpecDiffEntry>,
  changed: ReadonlyArray<SpecDiffChange>,
): string {
  if (added.length === 0 && removed.length === 0 && changed.length === 0) return "";
  const parts: string[] = [];
  const dataTransformChange = changed.find((c) => c.path.endsWith("/transform"));
  if (dataTransformChange) {
    parts.push(
      `data.transform changed (${truncate(String(dataTransformChange.before))} → ${truncate(String(dataTransformChange.after))})`,
    );
  }
  const sourceChange = changed.find((c) => c.path === "/data/source");
  if (sourceChange) parts.push(`source: ${sourceChange.before} → ${sourceChange.after}`);

  const layerAdds = added.filter((a) => /^\/layers\/\d+$/.test(a.path));
  const layerRemoves = removed.filter((r) => /^\/layers\/\d+$/.test(r.path));
  if (layerAdds.length > 0) parts.push(`${layerAdds.length} layer(s) added`);
  if (layerRemoves.length > 0) parts.push(`${layerRemoves.length} layer(s) removed`);

  const encChanges = changed.filter((c) => c.path.includes("/encoding/"));
  if (encChanges.length > 0) {
    const ch = encChanges[0];
    if (ch) {
      parts.push(`${pathTail(ch.path)} encoding ${ch.before === undefined ? "set" : "changed"}`);
    }
  }

  if (parts.length === 0) {
    parts.push(`${added.length} added, ${removed.length} removed, ${changed.length} changed`);
  }
  return `${parts.join("; ")}.`;
}

function pathTail(path: string): string {
  const parts = path.split("/");
  return parts[parts.length - 1] ?? path;
}

function truncate(s: string, n = 40): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}
