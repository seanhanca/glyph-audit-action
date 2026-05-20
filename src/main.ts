import { promises as fs, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as core from "@actions/core";
import { getExecOutput } from "@actions/exec";
import * as github from "@actions/github";
import { findChangedSpecs } from "./detect.js";
import { renderSpecDiff } from "./render.js";

async function run(): Promise<void> {
  try {
    const token = core.getInput("github-token") || process.env.GITHUB_TOKEN;
    if (!token) {
      // core.warning (not info) so the misconfiguration surfaces as an
      // annotation in the Actions UI — otherwise a workflow without a token
      // passes silently and the user wonders why the bot never comments.
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

    const files = await octokit.paginate(octokit.rest.pulls.listFiles, {
      owner,
      repo,
      pull_number: pr.number,
    });
    const changed = files.map((f) => f.filename);

    const pattern = core.getInput("spec-pattern") || "**/*.glyph.json";
    const specs = findChangedSpecs({
      changedFiles: changed,
      pattern,
    });
    core.info(`Detected ${specs.length} changed spec(s).`);
    if (specs.length === 0) {
      return;
    }

    const baseSha = pr.base.sha as string;
    const headSha = pr.head.sha as string;
    const glyphCmd = "glyph";

    // One workspace per action run; subdirs per spec keep image renders from
    // colliding when a PR touches more than one chart.
    const workRoot = mkdtempSync(join(tmpdir(), "glyph-audit-"));

    for (const spec of specs) {
      try {
        const safeName = spec.path.replace(/[^\w.-]+/g, "_");
        const specWorkDir = join(workRoot, safeName);
        await fs.mkdir(specWorkDir, { recursive: true });

        const basePath = join(specWorkDir, "base.json");
        const headPath = join(specWorkDir, "head.json");
        const imageDir = join(specWorkDir, "images");

        const baseContent = await fetchFileAtRef(octokit, owner, repo, baseSha, spec.path);
        const headContent = await fetchFileAtRef(octokit, owner, repo, headSha, spec.path);

        if (baseContent === null) {
          // New spec — no base to diff against. PR4 will widen this to a
          // "new chart" preview; for PR3 we just log + skip.
          core.info(`Spec ${spec.path} is new on this PR — skipping diff (no base).`);
          continue;
        }
        if (headContent === null) {
          // Spec was deleted on the PR — nothing to render.
          core.info(`Spec ${spec.path} was deleted on this PR — skipping.`);
          continue;
        }

        await fs.writeFile(basePath, baseContent, "utf8");
        await fs.writeFile(headPath, headContent, "utf8");

        const render = await renderSpecDiff({
          path: spec.path,
          base: basePath,
          head: headPath,
          glyphCmd,
          imageDir,
          exec: getExecOutput,
        });

        core.info(`--- glyph diff for ${spec.path} ---`);
        core.info(render.markdown);
        core.info(
          `Rendered ${render.imagePaths.length} image(s) to ${imageDir} ` +
            "(PR4 will upload them).",
        );
        // PR4 uploads `render.imagePaths`, rewrites `render.markdown` URLs;
        // PR5 upserts the sticky PR comment.
      } catch (specErr) {
        // One spec failing shouldn't kill the whole action — we want the
        // remaining specs in the PR to still produce comments.
        core.warning(
          `Failed to render diff for ${spec.path}: ` +
            (specErr instanceof Error ? specErr.message : String(specErr)),
        );
      }
    }
  } catch (err) {
    core.setFailed(err instanceof Error ? err.message : String(err));
  }
}

/**
 * Fetch a file's contents at a specific ref via the GitHub contents API.
 * Returns `null` when the file doesn't exist at that ref (e.g. it was added
 * on the PR, so it doesn't exist on the base SHA, or was deleted on the head).
 */
async function fetchFileAtRef(
  octokit: ReturnType<typeof github.getOctokit>,
  owner: string,
  repo: string,
  ref: string,
  path: string,
): Promise<string | null> {
  try {
    const res = await octokit.rest.repos.getContent({ owner, repo, ref, path });
    const data = res.data;
    // getContent returns an array for directories — defensive narrow.
    if (Array.isArray(data)) {
      throw new Error(`Path ${path} resolved to a directory at ref ${ref}.`);
    }
    if (data.type !== "file") {
      throw new Error(`Path ${path} is not a file at ref ${ref} (type=${data.type}).`);
    }
    // Files come back base64-encoded by default; "encoding" is always "base64"
    // for the contents endpoint but we check defensively.
    if (data.encoding !== "base64") {
      throw new Error(
        `Unexpected encoding ${data.encoding} for ${path}@${ref}; expected base64.`,
      );
    }
    return Buffer.from(data.content, "base64").toString("utf8");
  } catch (err) {
    // 404 = file doesn't exist at this ref; surface as null so the caller
    // can decide (new-file vs deleted-file).
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
