import * as core from "@actions/core";
import * as github from "@actions/github";
import { findChangedSpecPairs } from "./detect.js";

async function run(): Promise<void> {
  try {
    const token = core.getInput("github-token") || process.env.GITHUB_TOKEN;
    if (!token) {
      core.info("No GITHUB_TOKEN provided — skipping.");
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
    const specs = findChangedSpecPairs({
      changedFiles: changed,
      pattern,
    });
    core.info(`Detected ${specs.length} changed spec(s).`);
    // PR3 picks up from here — render diff + audit for each spec.
  } catch (err) {
    core.setFailed(err instanceof Error ? err.message : String(err));
  }
}

run();
