import * as core from "@actions/core";
import * as github from "@actions/github";
import { auditSpec, type AuditFinding } from "./audit.js";
import { upsertComment } from "./comment.js";
import { matchesPattern } from "./detect.js";
import {
  failureReason,
  parseFailOn,
  renderSpecSection,
  shouldFail,
  type FailOnLevel,
} from "./format.js";
import { diffSpecs, type SpecDiff } from "./spec-diff.js";

type Octokit = ReturnType<typeof github.getOctokit>;

/**
 * v0.2 redesign:
 *
 * - Audit runs for EVERY spec matching `spec-pattern`, NOT just the specs
 *   touched by the PR (the v0.1.0 behavior, which silently skipped new
 *   files — they had no base SHA to diff against).
 * - Diff is still PR-scoped (you can only "diff" something that existed
 *   before), but the audit section of the comment is always populated.
 * - `fail-on` is honored. `core.setFailed` runs at the END so adopters
 *   see the comment even on a red build.
 * - No CLI subprocess. The audit + diff are vendored from `@glyph/core`
 *   (see `src/audit.ts`, `src/spec-diff.ts`) and bundled into
 *   `dist/index.js` by ncc. Adopter workflows no longer need
 *   `npm install -g @glyph/cli`.
 */
async function run(): Promise<void> {
  try {
    const token = core.getInput("github-token") || process.env.GITHUB_TOKEN;
    if (!token) {
      core.warning(
        "No GITHUB_TOKEN available. Set permissions.pull-requests to write " +
          "on the workflow job, or pass a token via the `github-token` input.",
      );
      return;
    }
    const octokit = github.getOctokit(token);
    const { owner, repo } = github.context.repo;
    const pr = github.context.payload.pull_request;
    if (!pr) {
      core.info("No PR context — skipping.");
      return;
    }

    const pattern = core.getInput("spec-pattern") || "**/*.glyph.json";
    const failOn: FailOnLevel = parseFailOn(core.getInput("fail-on"));

    const baseSha = pr.base.sha as string;
    const headSha = pr.head.sha as string;

    // Validate comment-mode early so a typo surfaces as a clear failure
    // instead of being silently coerced. Default is sticky.
    const commentModeInput = (core.getInput("comment-mode") || "sticky").trim();
    if (commentModeInput !== "sticky" && commentModeInput !== "new") {
      core.warning(
        `Unknown comment-mode "${commentModeInput}" — falling back to "sticky". ` +
          'Valid values: "sticky" | "new".',
      );
    }
    const commentMode: "sticky" | "new" = commentModeInput === "new" ? "new" : "sticky";

    // 1. Enumerate every spec at HEAD that matches the pattern. This is the
    //    list we audit — broader than v0.1.0's "changed files only", which
    //    silently dropped new specs (the most common case for adopters
    //    incrementally adding charts to a project).
    const specPaths = await listSpecsAtRef(octokit, owner, repo, headSha, pattern);
    core.info(`Found ${specPaths.length} spec(s) matching "${pattern}" at HEAD.`);

    if (specPaths.length === 0) {
      // Nothing to audit — skip the comment entirely. A "0 charts" comment
      // would be noise on PRs that don't touch chart specs.
      core.info("No matching specs — skipping audit + comment.");
      return;
    }

    const allFindings: AuditFinding[] = [];
    const sections: string[] = [];

    for (const path of specPaths) {
      try {
        // Fetch head version (must exist since we just listed it).
        const headContent = await fetchFileAtRef(octokit, owner, repo, headSha, path);
        if (headContent === null) {
          // Race condition: spec disappeared between listing and fetch.
          // Unusual but recoverable — just skip the spec.
          core.warning(`Spec ${path} disappeared between listing and fetch — skipping.`);
          continue;
        }
        let headSpec: unknown;
        try {
          headSpec = JSON.parse(headContent);
        } catch (parseErr) {
          core.warning(
            `Spec ${path} is not valid JSON — skipping audit. ` +
              (parseErr instanceof Error ? parseErr.message : String(parseErr)),
          );
          continue;
        }
        if (typeof headSpec !== "object" || headSpec === null) {
          core.warning(`Spec ${path} did not parse to an object — skipping.`);
          continue;
        }

        // 2. Diff is BEST-EFFORT. If the file is new on this PR (404 on
        //    base) we render the audit section only and skip the diff.
        let diff: SpecDiff | null = null;
        const baseContent = await fetchFileAtRef(octokit, owner, repo, baseSha, path);
        if (baseContent !== null) {
          try {
            const baseSpec = JSON.parse(baseContent);
            diff = diffSpecs(baseSpec, headSpec);
          } catch (parseErr) {
            // Base parse failure shouldn't kill the audit — just drop the diff.
            core.warning(
              `Base version of ${path} is not valid JSON — diff section skipped. ` +
                (parseErr instanceof Error ? parseErr.message : String(parseErr)),
            );
          }
        }

        // 3. Audit. We don't have row/color cardinality at action time
        //    (those'd come from the materializer); the action audits
        //    structural/schema rules only.
        const findings = auditSpec({ spec: headSpec as Record<string, unknown> });
        allFindings.push(...findings);

        sections.push(renderSpecSection({ path, diff, findings }));
      } catch (specErr) {
        // One spec failing shouldn't kill the whole action.
        core.warning(
          `Failed to audit ${path}: ` +
            (specErr instanceof Error ? specErr.message : String(specErr)),
        );
      }
    }

    if (sections.length === 0) {
      core.info("No spec sections produced — skipping PR comment.");
      return;
    }

    const header = buildHeader({
      sectionCount: sections.length,
      headSha,
      findingCount: allFindings.length,
    });
    const body = [header, ...sections].join("\n\n---\n\n");

    await upsertComment({
      octokit,
      owner,
      repo,
      prNumber: pr.number,
      body,
      mode: commentMode,
    });

    // 4. Fail at the END so the comment lands first. Adopters with
    //    `fail-on: error` still see the audit report on a red build.
    if (shouldFail(allFindings, failOn)) {
      core.setFailed(failureReason(allFindings, failOn));
    }
  } catch (err) {
    core.setFailed(err instanceof Error ? err.message : String(err));
  }
}

/**
 * Build the comment header — one line per run, naming the count of specs
 * we audited and the head SHA the report was computed against.
 */
function buildHeader(args: {
  sectionCount: number;
  headSha: string;
  findingCount: number;
}): string {
  const s = args.sectionCount === 1 ? "" : "s";
  return (
    `### Glyph chart audit\n\n` +
    `Audited **${args.sectionCount}** chart spec${s} at \`${args.headSha.slice(0, 7)}\` — ` +
    `**${args.findingCount}** total finding${args.findingCount === 1 ? "" : "s"}.`
  );
}

/**
 * List every file at `ref` that matches the spec glob. Uses the recursive
 * git-tree API (one request for the whole repo). Trees > 100k entries
 * come back truncated; in that case we'd need a different strategy, but
 * a repo that big with `.glyph.json` files all over is not the v0.2
 * target user. We surface the truncation as a warning so it's visible.
 */
async function listSpecsAtRef(
  octokit: Octokit,
  owner: string,
  repo: string,
  ref: string,
  pattern: string,
): Promise<string[]> {
  const tree = await octokit.rest.git.getTree({
    owner,
    repo,
    tree_sha: ref,
    recursive: "true",
  });
  if (tree.data.truncated) {
    core.warning(
      `Git tree at ${ref.slice(0, 7)} was truncated by GitHub — some specs may be missing ` +
        `from the audit. Repos with > ~100k entries need a different listing strategy.`,
    );
  }
  const files = tree.data.tree
    .filter((entry) => entry.type === "blob" && typeof entry.path === "string")
    .map((entry) => entry.path as string);
  return files.filter((p) => matchesPattern(p, pattern)).sort();
}

/**
 * Fetch a file's contents at a specific ref via the GitHub contents API.
 * Returns `null` when the file doesn't exist at that ref (e.g. it was added
 * on the PR, so it doesn't exist on the base SHA).
 */
async function fetchFileAtRef(
  octokit: Octokit,
  owner: string,
  repo: string,
  ref: string,
  path: string,
): Promise<string | null> {
  try {
    const res = await octokit.rest.repos.getContent({ owner, repo, ref, path });
    const data = res.data;
    if (Array.isArray(data)) {
      throw new Error(`Path ${path} resolved to a directory at ref ${ref}.`);
    }
    if (data.type !== "file") {
      throw new Error(`Path ${path} is not a file at ref ${ref} (type=${data.type}).`);
    }
    if (data.encoding !== "base64") {
      throw new Error(
        `Unexpected encoding ${data.encoding} for ${path}@${ref}; expected base64.`,
      );
    }
    return Buffer.from(data.content, "base64").toString("utf8");
  } catch (err) {
    if (
      err !== null &&
      typeof err === "object" &&
      "status" in err &&
      (err as { status: number }).status === 404
    ) {
      return null;
    }
    throw err;
  }
}

run();
