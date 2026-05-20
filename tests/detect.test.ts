import { describe, it, expect } from "vitest";
import { findChangedSpecPairs } from "../src/detect.js";

describe("findChangedSpecPairs", () => {
  it("returns base+head paths for each changed spec", () => {
    const result = findChangedSpecPairs({
      changedFiles: ["charts/sales.glyph.json", "src/app.ts"],
      pattern: "**/*.glyph.json",
    });
    expect(result).toEqual([{ path: "charts/sales.glyph.json" }]);
  });

  it("ignores non-spec files", () => {
    const result = findChangedSpecPairs({
      changedFiles: ["src/main.ts", "README.md"],
      pattern: "**/*.glyph.json",
    });
    expect(result).toEqual([]);
  });

  it("honors custom patterns", () => {
    const result = findChangedSpecPairs({
      changedFiles: ["plots/foo.json"],
      pattern: "plots/*.json",
    });
    expect(result).toEqual([{ path: "plots/foo.json" }]);
  });
});
