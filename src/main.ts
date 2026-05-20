import { promises as fs, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as core from "@actions/core";
import { getExecOutput } from "@actions/exec";
import * as github from "@actions/github";
import { upsertComment } from "./comment.js";
import { findChangedSpecs } from "./detect.js";
import { replaceMarkdownLinkTarget } from "./markdown.js";
import { renderSpecDiff } from "./render.js";
import { uploadSvgsToBranch } from "./upload.js";

// Branch we commit rendered SVGs to. Hardcoded for now — PR6 may expose
// this as an action input if real usage demands it.
const AUDIT_BRANCH = ".glyph-audit";

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

    // Wire the `glyph-version` action input. When set, shell out via
    // `npx -y @glyph/cli@<version>` so the workflow doesn't need a separate
    // install step. "latest" or empty → assume `glyph` is already on PATH
    // (the documented prereq for now).
    const glyphVersion = core.getInput("glyph-version");
    const glyphCmd: string[] =
      glyphVersion && glyphVersion !== "latest"
        ? ["npx", "-y", `@glyph/cli@${glyphVersion}`]
        : ["glyph"];

    // One workspace per action run; subdirs per spec keep image renders from
    // colliding when a PR touches more than one chart. Cleaned in `finally`
    // below so self-hosted runners don't accumulate per-PR detritus.
    const workRoot = mkdtempSync(join(tmpdir(), "glyph-audit-"));

    // Validate `comment-mode` early so a typo surfaces as a clear failure
    // instead of being silently coerced to `new` downstream. The default in
    // `action.yml` is `sticky`, so empty-string here also resolves to sticky.
    const commentModeInput = (core.getInput("comment-mode") || "sticky").trim();
    if (commentModeInput !== "sticky" && commentModeInput !== "new") {
      core.warning(
        `Unknown comment-mode "${commentModeInput}" — falling back to "sticky". ` +
          'Valid values: "sticky" | "new".',
      );
    }
    const commentMode: "sticky" | "new" = commentModeInput === "new" ? "new" : "sticky";

    // Accumulator: one section of markdown per successfully-processed spec.
    // We emit ONE comment per run (sticky-upsert or new-create) at the end —
    // not one per spec — so a PR touching 5 charts produces 1 comment, not 5.
    const sections: string[] = [];

    try {
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

          // Upload the rendered SVGs to the orphan `.glyph-audit` branch and
          // rewrite the local-path references inside the CLI's markdown to
          // point at the resulting raw URLs. PR5 will use this rewritten
          // markdown as the sticky-comment body. We do this even when no
          // images came back so the comment still renders (it just won't
          // have a Render section).
          let markdown = render.markdown;
          if (render.imagePaths.length > 0) {
            const urls = await uploadSvgsToBranch({
              octokit,
              owner,
              repo,
              branch: AUDIT_BRANCH,
              commitSha: headSha,
              svgPaths: render.imagePaths,
            });
            // The CLI emits markdown like `![alt](before.svg)` with
            // basename-only refs (the image-dir is its own scope). We MUST
            // anchor the rewrite to the markdown image-link form `](X)` —
            // a substring `before.svg` could otherwise show up in a JSON
            // diff line, a code fence, or the user's own spec path (e.g.
            // `charts/before.svg.glyph.json`) and would be incorrectly
            // clobbered into a raw URL.
            for (const [local, url] of Object.entries(urls)) {
              const base = local.split("/").pop();
              // Replace `](basename)` → `](url)` and `](abs/path)` → `](url)`.
              // Anchoring on the `](...)` enclosure prevents collateral hits.
              markdown = replaceMarkdownLinkTarget(markdown, local, url);
              if (base) {
                markdown = replaceMarkdownLinkTarget(markdown, base, url);
              }
            }
            core.info(`Uploaded ${render.imagePaths.length} image(s) to ${AUDIT_BRANCH}.`);
          } else {
            core.info(`No images rendered for ${spec.path}; comment will be text-only.`);
          }

          core.info(`--- glyph diff for ${spec.path} ---`);
          core.info(markdown);

          // Accumulate; the comment is upserted ONCE after the loop. We
          // include the spec path as a `<h2>` so multi-chart PRs get a
          // navigable, scannable comment instead of a wall of diffs.
          sections.push(`## \`${spec.path}\`\n\n${markdown}`);
        } catch (specErr) {
          // One spec failing shouldn't kill the whole action — we want the
          // remaining specs in the PR to still produce comments.
          core.warning(
            `Failed to render diff for ${spec.path}: ` +
              (specErr instanceof Error ? specErr.message : String(specErr)),
          );
        }
      }
    } finally {
      // Best-effort tmpdir cleanup. GitHub-hosted runners GC per-job, but
      // self-hosted runners would otherwise accumulate one workspace per PR.
      await fs.rm(workRoot, { recursive: true, force: true }).catch(() => {
        // Ignore — cleanup is best-effort.
      });
    }

    // Skip the comment entirely when EVERY spec failed — there's nothing
    // useful to post, and a "0 charts rendered" comment would be noise. The
    // per-spec warnings already surfaced as Actions annotations.
    if (sections.length === 0) {
      core.info("No spec sections produced — skipping PR comment.");
      return;
    }

    const header =
      `### Glyph chart audit\n\n` +
      `Rendered **${sections.length}** chart spec${sections.length === 1 ? "" : "s"} ` +
      `at \`${headSha.slice(0, 7)}\`.`;
    const body = [header, ...sections].join("\n\n---\n\n");

    await upsertComment({
      octokit,
      owner,
      repo,
      prNumber: pr.number,
      body,
      mode: commentMode,
    });
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
