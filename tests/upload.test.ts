import { describe, it, expect, vi, beforeEach } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { uploadSvgsToBranch } from "../src/upload.js";

// We hand-mock octokit instead of pulling in `nock` — the @actions/github
// octokit instance is just a bag of function refs, so a typed stub is more
// honest about exactly what surface we depend on (Git Data API only).
type Stubs = {
  createBlob: ReturnType<typeof vi.fn>;
  createTree: ReturnType<typeof vi.fn>;
  createCommit: ReturnType<typeof vi.fn>;
  createRef: ReturnType<typeof vi.fn>;
  updateRef: ReturnType<typeof vi.fn>;
  getRef: ReturnType<typeof vi.fn>;
  getCommit: ReturnType<typeof vi.fn>;
};

function makeOctokit(stubs: Stubs) {
  return {
    rest: {
      git: stubs,
    },
    // biome-ignore lint/suspicious/noExplicitAny: test double, intentional cast
  } as any;
}

function notFound(): Error & { status: number } {
  const e = new Error("Not Found") as Error & { status: number };
  e.status = 404;
  return e;
}

function makeSvg(dir: string, name: string, body: string): string {
  const p = join(dir, name);
  writeFileSync(p, body, "utf8");
  return p;
}

describe("uploadSvgsToBranch", () => {
  let workDir: string;

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), "glyph-upload-test-"));
  });

  it("blob → tree → commit → updateRef when branch already exists", async () => {
    const before = makeSvg(workDir, "before.svg", "<svg>before</svg>");
    const after = makeSvg(workDir, "after.svg", "<svg>after</svg>");

    const stubs: Stubs = {
      // Branch already exists — getRef succeeds → parent commit found → updateRef path.
      getRef: vi.fn().mockResolvedValue({ data: { object: { sha: "parent-commit-sha" } } }),
      getCommit: vi.fn().mockResolvedValue({ data: { tree: { sha: "parent-tree-sha" } } }),
      createBlob: vi
        .fn()
        .mockResolvedValueOnce({ data: { sha: "blob-sha-before" } })
        .mockResolvedValueOnce({ data: { sha: "blob-sha-after" } }),
      createTree: vi.fn().mockResolvedValue({ data: { sha: "new-tree-sha" } }),
      createCommit: vi.fn().mockResolvedValue({ data: { sha: "new-commit-sha" } }),
      createRef: vi.fn(),
      updateRef: vi.fn().mockResolvedValue({ data: { object: { sha: "new-commit-sha" } } }),
    };

    const urls = await uploadSvgsToBranch({
      octokit: makeOctokit(stubs),
      owner: "octo",
      repo: "demo",
      branch: ".glyph-audit",
      commitSha: "deadbeef",
      svgPaths: [before, after],
    });

    // createBlob: one call per SVG, with the file's contents.
    expect(stubs.createBlob).toHaveBeenCalledTimes(2);
    expect(stubs.createBlob).toHaveBeenCalledWith({
      owner: "octo",
      repo: "demo",
      content: "<svg>before</svg>",
      encoding: "utf-8",
    });
    expect(stubs.createBlob).toHaveBeenCalledWith({
      owner: "octo",
      repo: "demo",
      content: "<svg>after</svg>",
      encoding: "utf-8",
    });

    // createTree: built off the parent tree, pointing at the new blob SHAs,
    // with paths under the commitSha subdir.
    expect(stubs.createTree).toHaveBeenCalledTimes(1);
    const treeCall = stubs.createTree.mock.calls[0][0];
    expect(treeCall.owner).toBe("octo");
    expect(treeCall.repo).toBe("demo");
    expect(treeCall.base_tree).toBe("parent-tree-sha");
    expect(treeCall.tree).toEqual([
      { path: "deadbeef/before.svg", mode: "100644", type: "blob", sha: "blob-sha-before" },
      { path: "deadbeef/after.svg", mode: "100644", type: "blob", sha: "blob-sha-after" },
    ]);

    // createCommit fast-forwards off the existing tip.
    expect(stubs.createCommit).toHaveBeenCalledTimes(1);
    expect(stubs.createCommit).toHaveBeenCalledWith({
      owner: "octo",
      repo: "demo",
      message: "chore(audit): upload renders for deadbeef",
      tree: "new-tree-sha",
      parents: ["parent-commit-sha"],
    });

    // Existing branch → updateRef, not createRef.
    expect(stubs.updateRef).toHaveBeenCalledTimes(1);
    expect(stubs.updateRef).toHaveBeenCalledWith({
      owner: "octo",
      repo: "demo",
      ref: "heads/.glyph-audit",
      sha: "new-commit-sha",
    });
    expect(stubs.createRef).not.toHaveBeenCalled();

    // The returned URL map keys on local path, values are raw URLs.
    expect(urls[before]).toBe(
      "https://raw.githubusercontent.com/octo/demo/.glyph-audit/deadbeef/before.svg",
    );
    expect(urls[after]).toBe(
      "https://raw.githubusercontent.com/octo/demo/.glyph-audit/deadbeef/after.svg",
    );
  });

  it("falls back to createRef + orphan commit when branch doesn't exist yet", async () => {
    const svg = makeSvg(workDir, "before.svg", "<svg/>");

    const stubs: Stubs = {
      // Branch missing — getRef raises 404 → we hit the orphan / createRef branch.
      getRef: vi.fn().mockRejectedValue(notFound()),
      getCommit: vi.fn(),
      createBlob: vi.fn().mockResolvedValue({ data: { sha: "blob-sha" } }),
      createTree: vi.fn().mockResolvedValue({ data: { sha: "tree-sha" } }),
      createCommit: vi.fn().mockResolvedValue({ data: { sha: "commit-sha" } }),
      createRef: vi.fn().mockResolvedValue({ data: { object: { sha: "commit-sha" } } }),
      updateRef: vi.fn(),
    };

    await uploadSvgsToBranch({
      octokit: makeOctokit(stubs),
      owner: "octo",
      repo: "demo",
      branch: ".glyph-audit",
      commitSha: "deadbeef",
      svgPaths: [svg],
    });

    // No parent commit lookup — getRef threw, so we never call getCommit.
    expect(stubs.getCommit).not.toHaveBeenCalled();
    // Tree has no base_tree (orphan).
    expect(stubs.createTree.mock.calls[0][0].base_tree).toBeUndefined();
    // Commit has empty parents (truly orphan).
    expect(stubs.createCommit.mock.calls[0][0].parents).toEqual([]);
    // First-time path uses createRef with refs/heads/<branch>.
    expect(stubs.createRef).toHaveBeenCalledWith({
      owner: "octo",
      repo: "demo",
      ref: "refs/heads/.glyph-audit",
      sha: "commit-sha",
    });
    expect(stubs.updateRef).not.toHaveBeenCalled();
  });

  it("returns an empty map (and skips every API call) when given no SVGs", async () => {
    const stubs: Stubs = {
      getRef: vi.fn(),
      getCommit: vi.fn(),
      createBlob: vi.fn(),
      createTree: vi.fn(),
      createCommit: vi.fn(),
      createRef: vi.fn(),
      updateRef: vi.fn(),
    };

    const urls = await uploadSvgsToBranch({
      octokit: makeOctokit(stubs),
      owner: "octo",
      repo: "demo",
      branch: ".glyph-audit",
      commitSha: "deadbeef",
      svgPaths: [],
    });

    expect(urls).toEqual({});
    // Critically — no API calls. Avoids accidentally creating the branch
    // when the action runs on a PR with zero chart changes.
    expect(stubs.getRef).not.toHaveBeenCalled();
    expect(stubs.createBlob).not.toHaveBeenCalled();
    expect(stubs.createTree).not.toHaveBeenCalled();
    expect(stubs.createCommit).not.toHaveBeenCalled();
    expect(stubs.createRef).not.toHaveBeenCalled();
    expect(stubs.updateRef).not.toHaveBeenCalled();
  });
});
