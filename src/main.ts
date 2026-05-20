import * as core from "@actions/core";

async function run(): Promise<void> {
  try {
    core.info("glyph-audit-action starting (PR1 stub)");
    // PR1 ships nothing functional — just the scaffolding.
    // PR2 adds changed-file detection; PR3 adds CLI invocation;
    // PR4 uploads renders; PR5 posts the sticky comment.
  } catch (err) {
    core.setFailed(err instanceof Error ? err.message : String(err));
  }
}

run();
