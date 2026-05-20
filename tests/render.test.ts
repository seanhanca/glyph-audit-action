import { describe, it, expect, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderSpecDiff } from "../src/render.js";

describe("renderSpecDiff", () => {
  it("invokes the glyph CLI with diff + --format md + --image-dir", async () => {
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
      glyphCmd: "glyph",
      imageDir,
      exec: execMock,
    });

    expect(execMock).toHaveBeenCalledTimes(1);
    expect(execMock).toHaveBeenCalledWith(
      "glyph",
      expect.arrayContaining([
        "diff",
        "/tmp/base.json",
        "/tmp/head.json",
        "--format",
        "md",
        "--image-dir",
        imageDir,
      ]),
      expect.any(Object),
    );
    expect(result.path).toBe("charts/sales.glyph.json");
    expect(result.markdown).toContain("Glyph chart change");
    expect(Array.isArray(result.imagePaths)).toBe(true);
  });

  it("propagates errors from the glyph CLI", async () => {
    const execMock = vi.fn().mockRejectedValue(new Error("glyph: command not found"));
    await expect(
      renderSpecDiff({
        path: "charts/sales.glyph.json",
        base: "/tmp/base.json",
        head: "/tmp/head.json",
        glyphCmd: "glyph",
        imageDir: mkdtempSync(join(tmpdir(), "glyph-audit-test-")),
        exec: execMock,
      }),
    ).rejects.toThrow("glyph: command not found");
  });
});
