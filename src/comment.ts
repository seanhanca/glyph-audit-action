import type * as github from "@actions/github";

/**
 * The Octokit shape we depend on — just the Issues REST slice we actually
 * call. Typed as the return of `@actions/github`'s `getOctokit` so callers
 * can pass it directly without an extra cast.
 */
export type Octokit = ReturnType<typeof github.getOctokit>;

/**
 * Hidden HTML-comment marker we prepend to every sticky comment. GitHub's
 * markdown renderer drops HTML comments, so it's invisible to readers but
 * trivially findable on the next run.
 *
 * The string is intentionally namespaced so it won't collide with markers
 * other audit bots use. We anchor matches to the START of the comment body
 * (see {@link upsertComment}) so a user manually quoting our marker in
 * their own comment can't trick us into editing it.
 */
export const STICKY_MARKER = "<!-- glyph-audit-action:sticky -->";

export interface UpsertCommentArgs {
  octokit: Octokit;
  owner: string;
  repo: string;
  prNumber: number;
  /** Comment body, sans marker. The marker is prepended by this function. */
  body: string;
  /**
   * `sticky` — find an existing comment with our marker and edit it in place;
   * otherwise create. `new` — always create a fresh comment.
   */
  mode: "sticky" | "new";
}

/**
 * Post-or-update the action's PR comment.
 *
 * In `sticky` mode we paginate `listComments` (a busy PR can easily push
 * past the 100-per-page default) and look for any comment whose body STARTS
 * with our hidden marker. The strict prefix check guards against the edge
 * case where a user pastes our marker text into their own comment — we'd
 * otherwise clobber their content on the next push.
 */
export async function upsertComment(args: UpsertCommentArgs): Promise<void> {
  const fullBody = `${STICKY_MARKER}\n\n${args.body}`;

  if (args.mode === "new") {
    await args.octokit.rest.issues.createComment({
      owner: args.owner,
      repo: args.repo,
      issue_number: args.prNumber,
      body: fullBody,
    });
    return;
  }

  const existing = await args.octokit.paginate(args.octokit.rest.issues.listComments, {
    owner: args.owner,
    repo: args.repo,
    issue_number: args.prNumber,
    per_page: 100,
  });

  // Anchor on prefix, not `includes`, so a user quoting our marker in their
  // own comment can't be mistaken for our sticky comment.
  const ours = existing.find((c) => typeof c.body === "string" && c.body.startsWith(STICKY_MARKER));

  if (ours) {
    await args.octokit.rest.issues.updateComment({
      owner: args.owner,
      repo: args.repo,
      comment_id: ours.id,
      body: fullBody,
    });
    return;
  }

  await args.octokit.rest.issues.createComment({
    owner: args.owner,
    repo: args.repo,
    issue_number: args.prNumber,
    body: fullBody,
  });
}
