/**
 * Markdown formatters for the sticky PR comment.
 *
 * One section per audited spec. The shape is:
 *
 *   ## `<spec-path>`
 *
 *   <diff summary, if the spec changed on the PR>
 *   <diff details, collapsed in <details>>
 *
 *   ### Audit findings
 *   <N findings: X high, Y medium, Z low>
 *   <markdown table: rule | severity | path | message>
 *
 * The sticky-comment header (the run-level `### Glyph chart audit ...` line
 * and the separators between sections) is built in `main.ts`.
 *
 * Severity is rendered with all-caps text labels (`**HIGH**`), NOT emoji —
 * adopter projects may grep / filter the comment body, and emoji breaks
 * substring matches.
 */

import type { AuditFinding, AuditSeverity } from "./audit.js";
import type { SpecDiff } from "./spec-diff.js";

/**
 * Aggregate finding counts per severity. Used for the "N findings: X high,
 * Y medium, Z low" header line.
 */
export interface SeverityCounts {
  high: number;
  medium: number;
  low: number;
  total: number;
}

export function countBySeverity(findings: ReadonlyArray<AuditFinding>): SeverityCounts {
  const counts: SeverityCounts = { high: 0, medium: 0, low: 0, total: findings.length };
  for (const f of findings) {
    counts[f.severity]++;
  }
  return counts;
}

/**
 * The summary line that goes above the findings table. Examples:
 *
 *   "**0 findings** — clean."
 *   "**3 findings**: 1 HIGH, 1 MEDIUM, 1 LOW."
 */
export function summaryLine(counts: SeverityCounts): string {
  if (counts.total === 0) {
    return "**0 findings** — clean.";
  }
  const parts: string[] = [];
  if (counts.high > 0) parts.push(`${counts.high} HIGH`);
  if (counts.medium > 0) parts.push(`${counts.medium} MEDIUM`);
  if (counts.low > 0) parts.push(`${counts.low} LOW`);
  return `**${counts.total} finding${counts.total === 1 ? "" : "s"}**: ${parts.join(", ")}.`;
}

/**
 * Render the audit findings table for a single spec. Empty array → a
 * "no issues" stub so the comment isn't a sea of blank sections.
 */
export function renderFindingsTable(findings: ReadonlyArray<AuditFinding>): string {
  if (findings.length === 0) {
    return "_No audit findings._";
  }
  const header = `| Rule | Severity | Path | Message |\n| --- | --- | --- | --- |`;
  const rows = findings.map((f) => {
    const rule = escapeCell(f.rule_id);
    const sev = `**${f.severity.toUpperCase()}**`;
    const path = f.path ? `\`${escapeCell(f.path)}\`` : "—";
    const msg = escapeCell(f.message);
    return `| ${rule} | ${sev} | ${path} | ${msg} |`;
  });
  return [header, ...rows].join("\n");
}

/**
 * Render the diff section (added / removed / changed) as a collapsible
 * `<details>` block. Returns "" when the diff is empty.
 */
export function renderDiffSection(diff: SpecDiff): string {
  if (
    diff.added.length === 0 &&
    diff.removed.length === 0 &&
    diff.changed.length === 0
  ) {
    return "";
  }
  const lines: string[] = ["<details>", "<summary>Spec diff</summary>", ""];
  if (diff.summary) {
    lines.push(`_${diff.summary}_`);
    lines.push("");
  }
  if (diff.changed.length > 0) {
    lines.push("**Changed**");
    lines.push("");
    lines.push("```diff");
    for (const c of diff.changed) {
      lines.push(`- ${c.path}: ${formatVal(c.before)}`);
      lines.push(`+ ${c.path}: ${formatVal(c.after)}`);
    }
    lines.push("```");
    lines.push("");
  }
  if (diff.added.length > 0) {
    lines.push("**Added**");
    lines.push("");
    lines.push("```diff");
    for (const a of diff.added) {
      lines.push(`+ ${a.path}: ${formatVal(a.value)}`);
    }
    lines.push("```");
    lines.push("");
  }
  if (diff.removed.length > 0) {
    lines.push("**Removed**");
    lines.push("");
    lines.push("```diff");
    for (const r of diff.removed) {
      lines.push(`- ${r.path}: ${formatVal(r.value)}`);
    }
    lines.push("```");
    lines.push("");
  }
  lines.push("</details>");
  return lines.join("\n");
}

/**
 * Render a single spec's section: heading, optional diff, audit summary,
 * findings table. The caller joins multiple sections with `\n\n---\n\n`.
 */
export function renderSpecSection(args: {
  path: string;
  /** `null` when the spec is brand-new on the PR (no base SHA to diff against). */
  diff: SpecDiff | null;
  findings: ReadonlyArray<AuditFinding>;
}): string {
  const blocks: string[] = [`## \`${args.path}\``, ""];
  if (args.diff === null) {
    blocks.push("_New spec on this PR — no base version to diff against._");
    blocks.push("");
  } else {
    const diffMd = renderDiffSection(args.diff);
    if (diffMd) {
      blocks.push(diffMd);
      blocks.push("");
    } else {
      blocks.push("_No spec changes._");
      blocks.push("");
    }
  }
  blocks.push("### Audit findings");
  blocks.push("");
  blocks.push(summaryLine(countBySeverity(args.findings)));
  blocks.push("");
  blocks.push(renderFindingsTable(args.findings));
  return blocks.join("\n");
}

// ---------------------------------------------------------------------------
// `fail-on` threshold logic
// ---------------------------------------------------------------------------

export type FailOnLevel = "error" | "warning" | "any" | "none";

/**
 * Parse the `fail-on` action input. Anything we don't recognize falls
 * through to `"error"` (the v0.2 default — see action.yml). v0.1.0
 * defaulted to `"none"`, but v0.1 never read the input — so adopters
 * weren't relying on the prior default's behavior.
 */
export function parseFailOn(raw: string | undefined): FailOnLevel {
  const v = (raw ?? "").trim().toLowerCase();
  if (v === "error" || v === "warning" || v === "any" || v === "none") {
    return v;
  }
  return "error";
}

/**
 * Should the action exit non-zero given these findings and threshold?
 *
 *   `error`   — fail when ANY finding is `high`.
 *   `warning` — fail when ANY finding is `high` OR `medium`.
 *   `any`     — fail when there's any finding at all.
 *   `none`    — never fail on findings (comment-only mode).
 */
export function shouldFail(
  findings: ReadonlyArray<AuditFinding>,
  level: FailOnLevel,
): boolean {
  if (level === "none") return false;
  if (level === "any") return findings.length > 0;
  if (level === "warning") {
    return findings.some((f) => f.severity === "high" || f.severity === "medium");
  }
  // "error" — only high severity trips the build.
  return findings.some((f) => f.severity === "high");
}

/**
 * The human-readable failure reason. Used as the `core.setFailed` message
 * so the Actions UI annotation explains WHY the run is red.
 */
export function failureReason(
  findings: ReadonlyArray<AuditFinding>,
  level: FailOnLevel,
): string {
  const c = countBySeverity(findings);
  return (
    `Glyph audit gate: fail-on=${level}, findings=` +
    `${c.high} high / ${c.medium} medium / ${c.low} low.`
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Escape table-cell content so a `|` inside a message doesn't break the
 * markdown table layout. Newlines collapse to spaces (cells can't contain
 * a line break and stay in the same row).
 */
function escapeCell(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

function formatVal(v: unknown): string {
  if (typeof v === "string") return JSON.stringify(v);
  if (v === undefined) return "undefined";
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

// Re-export for convenience.
export type { AuditFinding, AuditSeverity };
