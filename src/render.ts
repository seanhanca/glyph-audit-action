import { promises as fs } from "node:fs";
import * as path from "node:path";

/**
 * Result of running `glyph diff` on one changed spec. `markdown` is the raw
 * CLI stdout — PR4 rewrites the image refs inside it to point at uploaded
 * URLs before PR5 posts it as a PR comment.
 */
export interface RenderResult {
  /** Path to the spec file in the PR repo (e.g. `charts/sales.glyph.json`). */
  path: string;
  /** Markdown produced by `glyph diff --format md`. */
  markdown: string;
  /** Absolute paths of every SVG (or other image) the CLI wrote to imageDir. */
  imagePaths: string[];
}

/**
 * Output shape of `@actions/exec`'s `getExecOutput`. We only care about
 * stdout in PR3, but the action exec API also surfaces stderr + exitCode.
 */
export interface ExecOutput {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/**
 * Function-shaped dep so tests can mock `@actions/exec` without ESM module
 * jiggery-pokery. In production we pass `getExecOutput` from `@actions/exec`.
 */
export type ExecFn = (
  commandLine: string,
  args: string[],
  options: Record<string, unknown>,
) => Promise<ExecOutput>;

export interface RenderSpecDiffArgs {
  /** Path to the spec file in the PR repo (informational only). */
  path: string;
  /** Path on disk to the base (pre-PR) version of the spec. */
  base: string;
  /** Path on disk to the head (post-PR) version of the spec. */
  head: string;
  /** Command used to invoke the glyph CLI (usually just "glyph"). */
  glyphCmd: string;
  /** Directory the CLI will write before/after renders into. Created if missing. */
  imageDir: string;
  /** Injected for testability — `getExecOutput` from `@actions/exec` in prod. */
  exec: ExecFn;
}

/**
 * Shell out to `glyph diff <base> <head> --format md --image-dir <imageDir>`
 * and collect the markdown + every SVG written into the image dir.
 *
 * PR3 only wires the call + return shape; PR4 reads `imagePaths`, uploads
 * each SVG, and rewrites references inside `markdown`. PR5 posts the result.
 */
export async function renderSpecDiff(args: RenderSpecDiffArgs): Promise<RenderResult> {
  await fs.mkdir(args.imageDir, { recursive: true });

  const { stdout } = await args.exec(
    args.glyphCmd,
    [
      "diff",
      args.base,
      args.head,
      "--format",
      "md",
      "--image-dir",
      args.imageDir,
    ],
    {
      // `getExecOutput` captures stdout/stderr for us regardless; setting
      // silent keeps the action log tidy when the CLI is chatty.
      silent: true,
    },
  );

  const imagePaths = await listImages(args.imageDir);
  return { path: args.path, markdown: stdout, imagePaths };
}

async function listImages(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  return entries
    .filter((e) => e.isFile() && /\.(svg|png)$/i.test(e.name))
    .map((e) => path.join(dir, e.name))
    .sort();
}
