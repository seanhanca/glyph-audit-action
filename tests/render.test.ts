import { describe, it, expect, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderSpecDiff } from "../src/render.js";

describe("renderSpecDiff", () => {
  it("invokes the glyph CLI with exact arg ordering and -- separator", async () => {
    const imageDir = mkdtempSync(join(tmpdir(), "glyph-audit-test-"));
    const execMock = vi.fn().mockResolvedValue({
      stdout: "## Glyph chart change\n\n### Diff\n```diff\n- foo\n+ bar\n```\n",
      stderr: "",
      exitCode: 0,
    });

    const result = await renderSpecDiff({
      path: "charts/sales.glyph.json",
      base: "/tmp/base.json",
      head: "/tmp/head.json",
      glyphCmd: ["glyph"],
      imageDir,
      exec: execMock,
    });

    expect(execMock).toHaveBeenCalledTimes(1);
    // Exact-order args — arg ordering is positional in `glyph diff`, so a
    // reorder regression (e.g. flags after positionals) would silently pass
    // an arrayContaining match.
    expect(execMock.mock.calls[0][0]).toBe("glyph");
    expect(execMock.mock.calls[0][1]).toEqual([
      "diff",
      "--format",
      "md",
      "--image-dir",
      imageDir,
      "--",
      "/tmp/base.json",
      "/tmp/head.json",
    ]);
    expect(result.path).toBe("charts/sales.glyph.json");
    expect(result.markdown).toContain("Glyph chart change");
    expect(Array.isArray(result.imagePaths)).toBe(true);
  });

  it("supports pinned glyph-version via npx-prefixed argv", async () => {
    const imageDir = mkdtempSync(join(tmpdir(), "glyph-audit-test-"));
    const execMock = vi.fn().mockResolvedValue({ stdout: "", stderr: "", exitCode: 0 });

    await renderSpecDiff({
      path: "charts/sales.glyph.json",
      base: "/tmp/base.json",
      head: "/tmp/head.json",
      glyphCmd: ["npx", "-y", "@glyph/cli@0.1.0"],
      imageDir,
      exec: execMock,
    });

    expect(execMock.mock.calls[0][0]).toBe("npx");
    expect(execMock.mock.calls[0][1]).toEqual([
      "-y",
      "@glyph/cli@0.1.0",
      "diff",
      "--format",
      "md",
      "--image-dir",
      imageDir,
      "--",
      "/tmp/base.json",
      "/tmp/head.json",
    ]);
  });

  it("propagates errors from the glyph CLI", async () => {
    const execMock = vi.fn().mockRejectedValue(new Error("glyph: command not found"));
    await expect(
      renderSpecDiff({
        path: "charts/sales.glyph.json",
        base: "/tmp/base.json",
        head: "/tmp/head.json",
        glyphCmd: ["glyph"],
        imageDir: mkdtempSync(join(tmpdir(), "glyph-audit-test-")),
        exec: execMock,
      }),
    ).rejects.toThrow("glyph: command not found");
  });
});
