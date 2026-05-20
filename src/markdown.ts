/**
 * Anchored markdown link-target replacement.
 *
 * `glyph diff --format md` emits image references shaped like
 * `![alt](before.svg)`. After uploading the SVGs to the orphan branch we
 * rewrite the `before.svg` / `after.svg` link target → the raw URL.
 *
 * The naive `markdown.split(target).join(url)` approach is unsafe: it also
 * replaces any incidental occurrence of `before.svg`, including the user's
 * own spec path (e.g. `charts/before.svg.glyph.json`), a token inside a
 * JSON diff line, a column label, or a code fence. Anchoring the match on
 * the `](X)` enclosure prevents that collateral damage.
 *
 * Exported separately from main.ts so the rest of main.ts (which runs
 * `octokit.paginate` etc. at module load via `run()`) doesn't show up as a
 * side-effecting import in tests that only need this helper.
 */
export function replaceMarkdownLinkTarget(
  markdown: string,
  target: string,
  url: string,
): string {
  // Escape regex metachars in the target so a filename like `chart.svg`
  // doesn't accidentally let `.` match any character.
  const escaped = target.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // The match group is `](TARGET)`; the URL form covers both image links
  // (`![alt](url)`) and plain links (`[label](url)`). Trailing `)` stays
  // inside the pattern so we keep the regex broadly portable.
  const pattern = new RegExp(`\\]\\(${escaped}\\)`, "g");
  return markdown.replace(pattern, `](${url})`);
}
