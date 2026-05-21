/**
 * Tests for the vendored auditor (src/audit.ts).
 *
 * The vendor is a 1:1 reimplementation of @glyph/core's auditor (PR63).
 * These tests cover the rules we explicitly call out in the v0.2 brief —
 * the example specs (`rides-by-hour.glyph.json` clean,
 * `intentional-truncated.glyph.json` trips AUDIT-01) plus a smoke set
 * across every rule. The upstream module has its own broader test suite;
 * this file's job is to confirm the vendor didn't drift.
 */
import { describe, expect, it } from "vitest";
import { auditSpec, type LooseSpec } from "../src/audit.js";

// The two example specs the brief calls out, inlined here so the test
// file is hermetic (doesn't reach into the glyph repo).
const cleanRidesByHour: LooseSpec = {
  title: "Rides by pickup hour",
  data: {
    source: "inline:examples-rides",
    transform:
      "SELECT pickup_hour, COUNT(*) AS rides FROM rides GROUP BY pickup_hour ORDER BY pickup_hour",
  },
  layers: [
    {
      mark: "bar",
      encoding: {
        x: { field: "pickup_hour", type: "ordinal" },
        y: { field: "rides", type: "quantitative" },
      },
    },
  ],
};

const intentionalTruncated: LooseSpec = {
  title: "Intentional: truncated y-axis (AUDIT-01 demo)",
  data: {
    source: "inline:examples-revenue",
    transform: "SELECT quarter, revenue FROM revenue ORDER BY quarter",
  },
  layers: [
    {
      mark: "bar",
      encoding: {
        x: { field: "quarter", type: "ordinal" },
        y: {
          field: "revenue",
          type: "quantitative",
          scale: { domain: [100, 200] },
        },
      },
    },
  ],
};

describe("auditSpec — example specs", () => {
  it("rides-by-hour is CLEAN (no high-severity findings)", () => {
    const findings = auditSpec({ spec: cleanRidesByHour });
    const high = findings.filter((f) => f.severity === "high");
    expect(high).toEqual([]);
  });

  it("intentional-truncated trips AUDIT-01 (high)", () => {
    const findings = auditSpec({ spec: intentionalTruncated });
    const audit01 = findings.find((f) => f.rule_id === "AUDIT-01");
    expect(audit01).toBeDefined();
    expect(audit01?.severity).toBe("high");
    expect(audit01?.path).toBe("/layers/0/encoding/y");
    // Message must mention the offending domain start so the comment
    // table makes sense without expanding the spec.
    expect(audit01?.message).toMatch(/100/);
  });
});

describe("auditSpec — rule smoke set", () => {
  it("AUDIT-02: flags dual-axis layers (left + right y)", () => {
    const findings = auditSpec({
      spec: {
        layers: [
          { mark: "line", encoding: { x: "t", y: "revenue" } },
          {
            mark: "line",
            encoding: { x: "t", y: { field: "users", scale: { side: "right" } } },
          },
        ],
      },
    });
    expect(findings.some((f) => f.rule_id === "AUDIT-02")).toBe(true);
  });

  it("AUDIT-03: flags log y scale without 'log' in title", () => {
    const findings = auditSpec({
      spec: {
        title: "Revenue over time",
        layers: [
          {
            mark: "line",
            encoding: { x: "t", y: { field: "rev", scale: { type: "log" } } },
          },
        ],
      },
    });
    const audit03 = findings.find((f) => f.rule_id === "AUDIT-03");
    expect(audit03).toBeDefined();
    expect(audit03?.severity).toBe("high");
  });

  it("AUDIT-03: silent when title mentions 'log'", () => {
    const findings = auditSpec({
      spec: {
        title: "Revenue (log scale)",
        layers: [
          {
            mark: "line",
            encoding: { x: "t", y: { field: "rev", scale: { type: "log" } } },
          },
        ],
      },
    });
    expect(findings.some((f) => f.rule_id === "AUDIT-03")).toBe(false);
  });

  it("AUDIT-04: flags rowCount < 5 on a bar chart", () => {
    const findings = auditSpec({
      spec: cleanRidesByHour,
      rowCount: 3,
    });
    expect(findings.some((f) => f.rule_id === "AUDIT-04")).toBe(true);
  });

  it("AUDIT-06: flags > 8 colors", () => {
    const findings = auditSpec({ spec: cleanRidesByHour, colorCardinality: 12 });
    expect(findings.some((f) => f.rule_id === "AUDIT-06")).toBe(true);
  });

  it("AUDIT-07: flags extreme aspect ratio", () => {
    const findings = auditSpec({
      spec: { ...cleanRidesByHour, width: 2000, height: 100 },
    });
    expect(findings.some((f) => f.rule_id === "AUDIT-07")).toBe(true);
  });

  it("AUDIT-08: flags diverging palette without midpoint", () => {
    const findings = auditSpec({
      spec: {
        layers: [
          {
            mark: "bar",
            encoding: {
              x: "x",
              y: "y",
              color: { field: "delta", scale: { scheme: "RdBu" } },
            },
          },
        ],
      },
    });
    expect(findings.some((f) => f.rule_id === "AUDIT-08")).toBe(true);
  });

  it("findings are sorted high → low by severity", () => {
    const findings = auditSpec({
      spec: {
        title: "Untitled",
        width: 2000,
        height: 100,
        layers: [
          {
            mark: "bar",
            encoding: {
              x: "x",
              y: { field: "y", scale: { type: "log", domain: [100, 200] } },
            },
          },
        ],
        colorCardinality: 12,
      },
      colorCardinality: 12,
    });
    expect(findings[0]?.severity).toBe("high");
    expect(findings[findings.length - 1]?.severity).toBe("low");
  });

  it("is deterministic — same input → same output", () => {
    const a = auditSpec({ spec: intentionalTruncated });
    const b = auditSpec({ spec: intentionalTruncated });
    expect(a).toEqual(b);
  });

  it("tolerates malformed input without throwing", () => {
    // The action loads raw JSON from a PR; a junk payload (string `layers`,
    // missing fields) MUST NOT crash the run. We return whatever findings
    // we could compute and move on.
    expect(() => auditSpec({ spec: { layers: "nope" } as unknown as LooseSpec })).not.toThrow();
    expect(() => auditSpec({ spec: {} })).not.toThrow();
    expect(() => auditSpec({ spec: { layers: [null, undefined, 42] } as unknown as LooseSpec })).not.toThrow();
  });
});
