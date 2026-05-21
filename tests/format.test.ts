/**
 * Tests for the comment-template + fail-on threshold logic
 * (src/format.ts).
 */
import { describe, expect, it } from "vitest";
import type { AuditFinding } from "../src/audit.js";
import {
  countBySeverity,
  failureReason,
  parseFailOn,
  renderFindingsTable,
  renderSpecSection,
  shouldFail,
  summaryLine,
} from "../src/format.js";
import type { SpecDiff } from "../src/spec-diff.js";

const highFinding: AuditFinding = {
  rule_id: "AUDIT-01",
  severity: "high",
  message: "Layer 0: bar chart y-axis domain starts at 100, not 0.",
  path: "/layers/0/encoding/y",
  suggestion: "Set scale.domain to [0, max].",
};
const medFinding: AuditFinding = {
  rule_id: "AUDIT-02",
  severity: "medium",
  message: "Dual-axis chart.",
};
const lowFinding: AuditFinding = {
  rule_id: "AUDIT-07",
  severity: "low",
  message: "Aspect ratio 20 (2000×100) is unusual.",
};

describe("countBySeverity", () => {
  it("aggregates correctly", () => {
    const c = countBySeverity([highFinding, medFinding, medFinding, lowFinding]);
    expect(c).toEqual({ high: 1, medium: 2, low: 1, total: 4 });
  });
  it("zero is zero", () => {
    expect(countBySeverity([])).toEqual({ high: 0, medium: 0, low: 0, total: 0 });
  });
});

describe("summaryLine", () => {
  it("0 findings → 'clean'", () => {
    expect(summaryLine(countBySeverity([]))).toBe("**0 findings** — clean.");
  });
  it("renders only nonzero severities", () => {
    const line = summaryLine(countBySeverity([highFinding, medFinding]));
    expect(line).toBe("**2 findings**: 1 HIGH, 1 MEDIUM.");
  });
  it("singular noun on count=1", () => {
    expect(summaryLine(countBySeverity([highFinding]))).toBe("**1 finding**: 1 HIGH.");
  });
});

describe("renderFindingsTable", () => {
  it("empty findings → no-issues stub", () => {
    expect(renderFindingsTable([])).toBe("_No audit findings._");
  });

  it("table has a header row, one row per finding, and severity is text (not emoji)", () => {
    const md = renderFindingsTable([highFinding, medFinding, lowFinding]);
    // Header row
    expect(md).toContain("| Rule | Severity | Path | Message |");
    // Severity rendered as TEXT label, never emoji (adopters may grep
    // the comment body — emoji breaks substring search).
    expect(md).toContain("**HIGH**");
    expect(md).toContain("**MEDIUM**");
    expect(md).toContain("**LOW**");
    expect(md).not.toMatch(/🔴|🟡|🟢|🔥/);
    // Rule ids surface
    expect(md).toContain("AUDIT-01");
    expect(md).toContain("AUDIT-07");
    // Path rendered in backticks when present
    expect(md).toContain("`/layers/0/encoding/y`");
    // No-path finding uses an em dash
    expect(md).toContain("| AUDIT-02 | **MEDIUM** | — |");
  });

  it("escapes `|` inside message cells so the table doesn't break", () => {
    const finding: AuditFinding = {
      rule_id: "AUDIT-99",
      severity: "low",
      message: "a | b | c",
    };
    const md = renderFindingsTable([finding]);
    // `\|` is the markdown escape — the literal `|` would otherwise
    // split a cell into multiple columns.
    expect(md).toContain("a \\| b \\| c");
  });
});

describe("renderSpecSection", () => {
  it("new-spec (diff=null) labels itself and still renders the audit table", () => {
    const md = renderSpecSection({
      path: "charts/new.glyph.json",
      diff: null,
      findings: [highFinding],
    });
    expect(md).toContain("## `charts/new.glyph.json`");
    expect(md).toContain("_New spec on this PR — no base version to diff against._");
    expect(md).toContain("### Audit findings");
    expect(md).toContain("AUDIT-01");
  });

  it("edited spec includes a diff block in a <details> collapsible", () => {
    const diff: SpecDiff = {
      added: [],
      removed: [],
      changed: [{ path: "/layers/0/encoding/y/scale/domain/0", before: 0, after: 100 }],
      summary: "domain encoding changed.",
    };
    const md = renderSpecSection({
      path: "charts/revenue.glyph.json",
      diff,
      findings: [highFinding],
    });
    expect(md).toContain("<details>");
    expect(md).toContain("</details>");
    expect(md).toContain("**Changed**");
    expect(md).toContain("/layers/0/encoding/y/scale/domain/0");
  });

  it("empty diff (no changes) says so explicitly", () => {
    const diff: SpecDiff = { added: [], removed: [], changed: [], summary: "" };
    const md = renderSpecSection({
      path: "charts/static.glyph.json",
      diff,
      findings: [],
    });
    expect(md).toContain("_No spec changes._");
  });
});

describe("parseFailOn", () => {
  it("recognizes every documented value", () => {
    expect(parseFailOn("error")).toBe("error");
    expect(parseFailOn("warning")).toBe("warning");
    expect(parseFailOn("any")).toBe("any");
    expect(parseFailOn("none")).toBe("none");
  });
  it("normalizes whitespace + casing", () => {
    expect(parseFailOn("  ERROR  ")).toBe("error");
  });
  it("falls back to 'error' on garbage", () => {
    expect(parseFailOn("yes-please")).toBe("error");
    expect(parseFailOn(undefined)).toBe("error");
    expect(parseFailOn("")).toBe("error");
  });
});

describe("shouldFail (the four threshold cases)", () => {
  const empty: AuditFinding[] = [];
  const onlyLow = [lowFinding];
  const onlyMed = [medFinding];
  const onlyHigh = [highFinding];
  const mixed = [highFinding, medFinding, lowFinding];

  it("error: only high trips", () => {
    expect(shouldFail(empty, "error")).toBe(false);
    expect(shouldFail(onlyLow, "error")).toBe(false);
    expect(shouldFail(onlyMed, "error")).toBe(false);
    expect(shouldFail(onlyHigh, "error")).toBe(true);
    expect(shouldFail(mixed, "error")).toBe(true);
  });

  it("warning: high OR medium trips", () => {
    expect(shouldFail(empty, "warning")).toBe(false);
    expect(shouldFail(onlyLow, "warning")).toBe(false);
    expect(shouldFail(onlyMed, "warning")).toBe(true);
    expect(shouldFail(onlyHigh, "warning")).toBe(true);
    expect(shouldFail(mixed, "warning")).toBe(true);
  });

  it("any: any finding trips", () => {
    expect(shouldFail(empty, "any")).toBe(false);
    expect(shouldFail(onlyLow, "any")).toBe(true);
    expect(shouldFail(onlyMed, "any")).toBe(true);
    expect(shouldFail(onlyHigh, "any")).toBe(true);
    expect(shouldFail(mixed, "any")).toBe(true);
  });

  it("none: NEVER trips, regardless of findings", () => {
    expect(shouldFail(empty, "none")).toBe(false);
    expect(shouldFail(onlyLow, "none")).toBe(false);
    expect(shouldFail(onlyMed, "none")).toBe(false);
    expect(shouldFail(onlyHigh, "none")).toBe(false);
    expect(shouldFail(mixed, "none")).toBe(false);
  });
});

describe("failureReason", () => {
  it("names the level and the count breakdown", () => {
    const msg = failureReason([highFinding, medFinding], "warning");
    expect(msg).toContain("fail-on=warning");
    expect(msg).toContain("1 high");
    expect(msg).toContain("1 medium");
  });
});
