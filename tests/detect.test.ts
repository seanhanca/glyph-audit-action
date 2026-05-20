import { describe, it, expect } from "vitest";
import { findChangedSpecs } from "../src/detect.js";

describe("findChangedSpecs", () => {
  it("returns the matching spec paths, ignoring everything else", () => {
    const result = findChangedSpecs({
      changedFiles: ["charts/sales.glyph.json", "src/app.ts"],
      pattern: "**/*.glyph.json",
    });
    expect(result).toEqual([{ path: "charts/sales.glyph.json" }]);
  });

  it("returns an empty array when no files match the pattern", () => {
    const result = findChangedSpecs({
      changedFiles: ["src/main.ts", "README.md"],
      pattern: "**/*.glyph.json",
    });
    expect(result).toEqual([]);
  });

  it("honors custom patterns supplied by the workflow", () => {
    const result = findChangedSpecs({
      changedFiles: ["plots/foo.json"],
      pattern: "plots/*.json",
    });
    expect(result).toEqual([{ path: "plots/foo.json" }]);
  });
});
