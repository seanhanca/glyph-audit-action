/**
 * Chart auditor — vendored from `@glyph/core/audit` for v0.2.
 *
 * The action used to subprocess out to `glyph diff` (which lived in the
 * unpublished `@glyph/cli`). For v0.2 we drop the subprocess entirely and
 * run the audit + diff in-process, so adopters get a zero-runtime-dep
 * `dist/index.js`.
 *
 * This file is a 1:1 reimplementation of the rule set in
 * `glyph/packages/core/src/audit/index.ts`. The signatures are stable; if
 * we ever publish `@glyph/core` we can swap to importing it without a
 * comment-format change.
 *
 * Rules implemented (matches @glyph/core@PR63):
 *
 *   AUDIT-01 (high)   Bar chart with y-axis not starting at 0.
 *   AUDIT-02 (medium) Dual-axis layers — left + right y axes.
 *   AUDIT-03 (high)   Log y scale without "log" in the title.
 *   AUDIT-04 (medium) rowCount < 5 on a bar chart (sparse aggregation).
 *   AUDIT-06 (low)    colorCardinality > 8 categories.
 *   AUDIT-07 (low)    Aspect ratio < 0.5 or > 3.
 *   AUDIT-08 (medium) Diverging palette without explicit midpoint.
 *   AUDIT-09 (medium) Multi-layer bar chart with y domain crossing zero.
 *
 * Deterministic, no clock, no LLM. Same input → same output.
 */

/** Severity tiers — `high` typically gates rendering when strictness=error. */
export type AuditSeverity = "low" | "medium" | "high";

/** A single audit finding. */
export interface AuditFinding {
  /** Stable id (e.g. "AUDIT-01") for filter / suppress workflows. */
  readonly rule_id: string;
  readonly severity: AuditSeverity;
  /** One-line description. */
  readonly message: string;
  /** Optional suggestion the agent / user can act on. */
  readonly suggestion?: string;
  /** RFC 6901 JSON pointer to the offending spec node (e.g. "/layers/0/encoding/y"). */
  readonly path?: string;
}

/**
 * The shape we expect a spec to have. We deliberately stay loose: the
 * action loads raw JSON from the PR and doesn't pull in Zod just to check
 * structural well-formedness here. Each rule narrows what it needs.
 */
export interface LooseSpec {
  readonly title?: unknown;
  readonly width?: unknown;
  readonly height?: unknown;
  readonly layers?: unknown;
  // Anything else passes through untouched.
  readonly [key: string]: unknown;
}

/** Input to `auditSpec`. Pass at least the spec; rows are optional. */
export interface AuditInput {
  readonly spec: LooseSpec;
  /** Optional row count for the underlying data (used by AUDIT-04). */
  readonly rowCount?: number;
  /** Optional total distinct colors used (used by AUDIT-06). */
  readonly colorCardinality?: number;
}

/**
 * Audit a spec, returning all findings sorted by severity desc, then rule_id.
 * Pure function — same input → same output, no side effects.
 */
export function auditSpec(input: AuditInput): ReadonlyArray<AuditFinding> {
  const out: AuditFinding[] = [];
  const { spec } = input;
  const layers = Array.isArray(spec.layers) ? (spec.layers as ReadonlyArray<unknown>) : [];
  const title = typeof spec.title === "string" ? (spec.title as string) : undefined;
  for (let i = 0; i < layers.length; i++) {
    const layer = layers[i];
    if (!isRecord(layer)) continue;
    auditTruncatedYAxis(out, layer, i);
    auditLogScaleDisclosure(out, layer, i, title);
    auditDivergingPalette(out, layer, i);
  }
  auditDualAxis(out, layers);
  auditExcessiveAggregation(out, layers, input.rowCount);
  auditColorCount(out, input.colorCardinality);
  auditAspectRatio(out, spec);
  auditStackedNegatives(out, layers);
  return out.sort((a, b) => {
    const sa = severityRank(a.severity);
    const sb = severityRank(b.severity);
    if (sa !== sb) return sb - sa;
    return a.rule_id.localeCompare(b.rule_id);
  });
}

function severityRank(s: AuditSeverity): number {
  return s === "high" ? 3 : s === "medium" ? 2 : 1;
}

// ---------------------------------------------------------------------------
// Rule: AUDIT-01 — truncated y axis on a bar chart
// ---------------------------------------------------------------------------

function auditTruncatedYAxis(
  out: AuditFinding[],
  layer: Record<string, unknown>,
  idx: number,
): void {
  if (layer.mark !== "bar") return;
  const enc = pickRecord(layer.encoding);
  const yCh = enc?.y;
  const domain = channelDomain(yCh);
  if (!domain) return;
  if (domain.length < 2) return;
  const lo = Number(domain[0]);
  if (!Number.isFinite(lo)) return;
  if (lo > 0) {
    out.push({
      rule_id: "AUDIT-01",
      severity: "high",
      message: `Layer ${idx}: bar chart y-axis domain starts at ${lo}, not 0 — bar heights misrepresent magnitude.`,
      suggestion:
        "Set scale.domain to [0, max] or use a different mark (point/line) when a non-zero baseline is intentional.",
      path: `/layers/${idx}/encoding/y`,
    });
  }
}

// ---------------------------------------------------------------------------
// Rule: AUDIT-03 — log scale without disclosure
// ---------------------------------------------------------------------------

function auditLogScaleDisclosure(
  out: AuditFinding[],
  layer: Record<string, unknown>,
  idx: number,
  title: string | undefined,
): void {
  const enc = pickRecord(layer.encoding);
  const yCh = enc?.y;
  const scaleType = channelScaleType(yCh);
  if (scaleType !== "log") return;
  const titleText = (title ?? "").toLowerCase();
  if (titleText.includes("log") || titleText.includes("logarithmic")) return;
  out.push({
    rule_id: "AUDIT-03",
    severity: "high",
    message: `Layer ${idx}: y axis uses a logarithmic scale but the chart title doesn't mention it.`,
    suggestion: "Add 'log' to the title or annotate the axis so readers don't read it as linear.",
    path: `/layers/${idx}/encoding/y`,
  });
}

// ---------------------------------------------------------------------------
// Rule: AUDIT-08 — diverging palette without explicit midpoint
// ---------------------------------------------------------------------------

function auditDivergingPalette(
  out: AuditFinding[],
  layer: Record<string, unknown>,
  idx: number,
): void {
  const enc = pickRecord(layer.encoding);
  const colorCh = enc?.color;
  if (!colorCh || typeof colorCh === "string") return;
  if (!isRecord(colorCh)) return;
  const scale = pickRecord(colorCh.scale);
  if (!scale) return;
  const scheme = typeof scale.scheme === "string" ? scale.scheme.toLowerCase() : "";
  if (!/diverging|rdbu|brbg|prgn|piyg|puor|rdgy|rdylbu|rdylgn/.test(scheme)) return;
  if (scale.midpoint !== undefined) return;
  out.push({
    rule_id: "AUDIT-08",
    severity: "medium",
    message: `Layer ${idx}: diverging color palette ("${scheme}") used without an explicit midpoint.`,
    suggestion: "Set color.scale.midpoint (typically 0) so readers know where the palette pivots.",
    path: `/layers/${idx}/encoding/color/scale`,
  });
}

// ---------------------------------------------------------------------------
// Rule: AUDIT-02 — dual-axis layers
// ---------------------------------------------------------------------------

function auditDualAxis(out: AuditFinding[], layers: ReadonlyArray<unknown>): void {
  if (layers.length < 2) return;
  const sides = layers.map((l) => {
    if (!isRecord(l)) return "left";
    const enc = pickRecord(l.encoding);
    const y = enc?.y;
    if (!y || typeof y === "string") return "left";
    if (!isRecord(y)) return "left";
    const scale = pickRecord(y.scale);
    return scale?.side === "right" ? "right" : "left";
  });
  const hasLeft = sides.includes("left");
  const hasRight = sides.includes("right");
  if (hasLeft && hasRight) {
    out.push({
      rule_id: "AUDIT-02",
      severity: "medium",
      message:
        "Dual-axis chart: layers use both left and right y axes. Readers often misjudge magnitudes when the two scales differ.",
      suggestion:
        "Prefer normalizing both series to a shared scale, or split into two stacked panels.",
    });
  }
}

// ---------------------------------------------------------------------------
// Rule: AUDIT-04 — excessive aggregation
// ---------------------------------------------------------------------------

function auditExcessiveAggregation(
  out: AuditFinding[],
  layers: ReadonlyArray<unknown>,
  rowCount: number | undefined,
): void {
  if (rowCount === undefined || rowCount === 0) return;
  for (let i = 0; i < layers.length; i++) {
    const layer = layers[i];
    if (!isRecord(layer) || layer.mark !== "bar") continue;
    const enc = pickRecord(layer.encoding);
    const xCh = enc?.x;
    if (!xCh) continue;
    if (rowCount < 5) {
      out.push({
        rule_id: "AUDIT-04",
        severity: "medium",
        message: `Layer ${i}: only ${rowCount} underlying rows — bar chart aggregates lose statistical power below 5 samples per category.`,
        suggestion:
          "Show the raw data as points or document the sample size in the chart subtitle.",
        path: `/layers/${i}`,
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Rule: AUDIT-06 — too many colors
// ---------------------------------------------------------------------------

function auditColorCount(out: AuditFinding[], colorCardinality: number | undefined): void {
  if (colorCardinality === undefined) return;
  if (colorCardinality > 8) {
    out.push({
      rule_id: "AUDIT-06",
      severity: "low",
      message: `Color encoding uses ${colorCardinality} distinct categories — readers can't reliably distinguish more than ~8.`,
      suggestion:
        "Group rarer categories under an 'Other' bucket, or facet by color instead of encoding it.",
    });
  }
}

// ---------------------------------------------------------------------------
// Rule: AUDIT-07 — extreme aspect ratio
// ---------------------------------------------------------------------------

function auditAspectRatio(out: AuditFinding[], spec: LooseSpec): void {
  const w = typeof spec.width === "number" ? spec.width : undefined;
  const h = typeof spec.height === "number" ? spec.height : undefined;
  if (w === undefined || h === undefined) return;
  if (h === 0) return;
  const ratio = w / h;
  if (ratio < 0.5 || ratio > 3) {
    out.push({
      rule_id: "AUDIT-07",
      severity: "low",
      message: `Aspect ratio ${ratio.toFixed(2)} (${w}×${h}) is unusual; very tall or wide charts can exaggerate trends.`,
      suggestion:
        "Keep width:height between 0.5 and 3 unless the data shape genuinely demands otherwise.",
    });
  }
}

// ---------------------------------------------------------------------------
// Rule: AUDIT-09 — stacked layers crossing zero
// ---------------------------------------------------------------------------

function auditStackedNegatives(out: AuditFinding[], layers: ReadonlyArray<unknown>): void {
  for (let i = 0; i < layers.length; i++) {
    const layer = layers[i];
    if (!isRecord(layer) || layer.mark !== "bar") continue;
    const enc = pickRecord(layer.encoding);
    const domain = channelDomain(enc?.y);
    if (!domain || domain.length < 2) continue;
    const lo = Number(domain[0]);
    const hi = Number(domain[domain.length - 1]);
    if (!Number.isFinite(lo) || !Number.isFinite(hi)) continue;
    if (lo < 0 && hi > 0 && layers.length > 1) {
      out.push({
        rule_id: "AUDIT-09",
        severity: "medium",
        message: `Layer ${i}: bar chart y domain crosses zero (${lo} → ${hi}) with multiple layers — stacking yields ambiguous totals.`,
        suggestion:
          "Split into separate panels for positive and negative values, or use diverging color encoding.",
        path: `/layers/${i}/encoding/y/scale/domain`,
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function pickRecord(v: unknown): Record<string, unknown> | undefined {
  return isRecord(v) ? v : undefined;
}

function channelDomain(c: unknown): ReadonlyArray<unknown> | undefined {
  if (!c || typeof c === "string") return undefined;
  if (!isRecord(c)) return undefined;
  const scale = pickRecord(c.scale);
  const domain = scale?.domain;
  return Array.isArray(domain) ? (domain as ReadonlyArray<unknown>) : undefined;
}

function channelScaleType(c: unknown): string | undefined {
  if (!c || typeof c === "string") return undefined;
  if (!isRecord(c)) return undefined;
  const scale = pickRecord(c.scale);
  return typeof scale?.type === "string" ? (scale.type as string) : undefined;
}
