import { promises as fs } from "node:fs";
import * as path from "node:path";
import type * as github from "@actions/github";

/**
 * The Octokit shape we depend on — just the slice of `git.*` (Git Data API)
 * we actually call. Typed as the return of `@actions/github`'s `getOctokit`
 * so callers can pass it directly without an extra cast.
 */
export type Octokit = ReturnType<typeof github.getOctokit>;

export interface UploadArgs {
  octokit: Octokit;
  owner: string;
  repo: string;
  /** Orphan branch to commit the SVGs to. Defaults to `.glyph-audit`. */
  branch: string;
  /**
   * PR head SHA — used as the subdir under the branch so concurrent PRs
   * don't clobber each other's renders.
   */
  commitSha: string;
  /** Absolute paths of every SVG to upload. */
  svgPaths: string[];
}

/**
 * Upload a batch of locally-rendered SVGs to an orphan branch of the same
 * repository via the GitHub Git Data API (`git.createBlob` → `git.createTree`
 * → `git.createCommit` → `git.updateRef` / `git.createRef`).
 *
 * The branch (`.glyph-audit` by default) is kept orphan — it doesn't share
 * history with `main` — and each PR head SHA gets its own subdir so the
 * branch stays diff-clean and concurrent PRs can't collide. Each upload is a
 * single fast-forward commit on top of whatever's already there.
 *
 * Returns a `local-path → raw-URL` map. URLs are
 * `https://raw.githubusercontent.com/<owner>/<repo>/<branch>/<sha>/<file>.svg`,
 * which renders inline in GitHub PR comments **for public repos only** —
 * private repos require auth headers and raw URLs won't display. PR4
 * documents this limitation; PR5 / PR6 may revisit.
 */
export async function uploadSvgsToBranch(args: UploadArgs): Promise<Record<string, string>> {
  const { octokit, owner, repo, branch, commitSha, svgPaths } = args;
  if (svgPaths.length === 0) {
    return {};
  }

  // 1. Read every SVG + push each as a blob. We do the reads in parallel
  //    because they're disk I/O; the blob uploads we serialize behind the
  //    reads but parallelize among themselves to stay polite to the API.
  const blobs = await Promise.all(
    svgPaths.map(async (local) => {
      const content = await fs.readFile(local, "utf8");
      const blob = await octokit.rest.git.createBlob({
        owner,
        repo,
        content,
        encoding: "utf-8",
      });
      return {
        local,
        filename: path.basename(local),
        sha: blob.data.sha,
      };
    }),
  );

  // 2. Look up the current tip of the orphan branch (if any). 404 means the
  //    branch doesn't exist yet — first PR for this repo to ever invoke the
  //    action — so we'll createRef instead of updateRef below.
  const ref = `heads/${branch}`;
  let parentCommitSha: string | null = null;
  let baseTreeSha: string | undefined;
  try {
    const refData = await octokit.rest.git.getRef({ owner, repo, ref });
    parentCommitSha = refData.data.object.sha;
    const parentCommit = await octokit.rest.git.getCommit({
      owner,
      repo,
      commit_sha: parentCommitSha,
    });
    baseTreeSha = parentCommit.data.tree.sha;
  } catch (err) {
    if (!isNotFoundError(err)) {
      throw err;
    }
    // Branch missing — `baseTreeSha` stays undefined → orphan tree on first run.
  }

  // 3. Build a tree containing every SVG under `<commitSha>/<filename>`.
  //    The path prefix is deliberate: it isolates this PR's renders from
  //    every other PR's renders on the same orphan branch.
  const tree = await octokit.rest.git.createTree({
    owner,
    repo,
    base_tree: baseTreeSha,
    tree: blobs.map((b) => ({
      path: `${commitSha}/${b.filename}`,
      mode: "100644",
      type: "blob",
      sha: b.sha,
    })),
  });

  // 4. Commit the tree. The parent list is empty when the branch is brand
  //    new (truly orphan); otherwise we fast-forward off the current tip.
  const commit = await octokit.rest.git.createCommit({
    owner,
    repo,
    message: `chore(audit): upload renders for ${commitSha}`,
    tree: tree.data.sha,
    parents: parentCommitSha ? [parentCommitSha] : [],
  });

  // 5. Move the branch tip. createRef for a brand-new branch, updateRef
  //    otherwise. We force-update is intentionally NOT used — we always
  //    fast-forward, so a non-FF would be a real bug worth surfacing.
  if (parentCommitSha === null) {
    await octokit.rest.git.createRef({
      owner,
      repo,
      ref: `refs/heads/${branch}`,
      sha: commit.data.sha,
    });
  } else {
    await octokit.rest.git.updateRef({
      owner,
      repo,
      ref,
      sha: commit.data.sha,
    });
  }

  // 6. Build the local → raw-URL map. raw.githubusercontent.com serves
  //    `<owner>/<repo>/<branch>/<path>`; branch names with a leading dot
  //    (`.glyph-audit`) are fine here — no need to URL-encode the dot.
  const urlMap: Record<string, string> = {};
  for (const b of blobs) {
    urlMap[b.local] =
      `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${commitSha}/${b.filename}`;
  }
  return urlMap;
}

function isNotFoundError(err: unknown): boolean {
  return (
    err !== null &&
    typeof err === "object" &&
    "status" in err &&
    (err as { status: number }).status === 404
  );
}
