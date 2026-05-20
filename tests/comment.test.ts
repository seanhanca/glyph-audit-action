import { describe, it, expect, vi } from "vitest";
import { STICKY_MARKER, upsertComment } from "../src/comment.js";

// Hand-mocked octokit (same approach as upload.test.ts) — the dependency
// surface is small enough that pulling in `nock` would obscure rather than
// clarify what we actually consume.
type IssuesStubs = {
  listComments: ReturnType<typeof vi.fn>;
  createComment: ReturnType<typeof vi.fn>;
  updateComment: ReturnType<typeof vi.fn>;
};

function makeOctokit(stubs: IssuesStubs, listResult: unknown[] = []) {
  return {
    rest: {
      issues: stubs,
    },
    // `paginate` is what `upsertComment` actually calls — short-circuit it
    // to return our canned list so we don't have to fake the page-link
    // headers that real paginate inspects.
    paginate: vi.fn().mockResolvedValue(listResult),
    // biome-ignore lint/suspicious/noExplicitAny: test double, intentional cast
  } as any;
}

describe("upsertComment", () => {
  it("sticky mode + no existing comment → creates a new comment with marker", async () => {
    const stubs: IssuesStubs = {
      listComments: vi.fn(),
      createComment: vi.fn().mockResolvedValue({ data: { id: 999 } }),
      updateComment: vi.fn(),
    };
    const octokit = makeOctokit(stubs, []);

    await upsertComment({
      octokit,
      owner: "octo",
      repo: "demo",
      prNumber: 42,
      body: "Hello world",
      mode: "sticky",
    });

    // paginate was used (NOT a direct listComments call) — we need this for
    // PRs with > 100 comments.
    expect(octokit.paginate).toHaveBeenCalledTimes(1);
    expect(octokit.paginate).toHaveBeenCalledWith(stubs.listComments, {
      owner: "octo",
      repo: "demo",
      issue_number: 42,
      per_page: 100,
    });

    // No existing → createComment, NOT updateComment.
    expect(stubs.createComment).toHaveBeenCalledTimes(1);
    expect(stubs.updateComment).not.toHaveBeenCalled();

    const call = stubs.createComment.mock.calls[0][0];
    expect(call.owner).toBe("octo");
    expect(call.repo).toBe("demo");
    expect(call.issue_number).toBe(42);
    // Marker MUST be the prefix of the body — that's what the next run's
    // sticky-search keys off.
    expect(call.body.startsWith(STICKY_MARKER)).toBe(true);
    expect(call.body).toContain("Hello world");
  });

  it("sticky mode + existing comment (marker found) → updates it, not creates", async () => {
    // Realistic listComments fixture: someone else's comment first, then ours,
    // then a third unrelated one. We MUST pick out the middle entry.
    const existing = [
      { id: 100, body: "Just a normal review comment." },
      { id: 200, body: `${STICKY_MARKER}\n\nOld audit content from a previous push.` },
      { id: 300, body: "LGTM" },
    ];
    const stubs: IssuesStubs = {
      listComments: vi.fn(),
      createComment: vi.fn(),
      updateComment: vi.fn().mockResolvedValue({ data: { id: 200 } }),
    };
    const octokit = makeOctokit(stubs, existing);

    await upsertComment({
      octokit,
      owner: "octo",
      repo: "demo",
      prNumber: 42,
      body: "Fresh audit content",
      mode: "sticky",
    });

    // The point of sticky: edit-in-place, do NOT create.
    expect(stubs.updateComment).toHaveBeenCalledTimes(1);
    expect(stubs.createComment).not.toHaveBeenCalled();

    const call = stubs.updateComment.mock.calls[0][0];
    expect(call.comment_id).toBe(200);
    // Round-trip: marker survives, fresh body is in there.
    expect(call.body.startsWith(STICKY_MARKER)).toBe(true);
    expect(call.body).toContain("Fresh audit content");
    expect(call.body).not.toContain("Old audit content");
  });

  it("new mode → always creates, even when a marker'd comment already exists", async () => {
    // Even with our marker visible in the listing, `mode: "new"` MUST bypass
    // the lookup entirely. (We also assert we didn't paginate — `new` mode
    // shouldn't waste a list call.)
    const stubs: IssuesStubs = {
      listComments: vi.fn(),
      createComment: vi.fn().mockResolvedValue({ data: { id: 555 } }),
      updateComment: vi.fn(),
    };
    const octokit = makeOctokit(stubs, [
      { id: 200, body: `${STICKY_MARKER}\n\nA previous sticky.` },
    ]);

    await upsertComment({
      octokit,
      owner: "octo",
      repo: "demo",
      prNumber: 7,
      body: "Per-push fresh comment",
      mode: "new",
    });

    expect(stubs.createComment).toHaveBeenCalledTimes(1);
    expect(stubs.updateComment).not.toHaveBeenCalled();
    expect(octokit.paginate).not.toHaveBeenCalled();
  });

  it("sticky mode ignores comments that merely MENTION the marker (prefix-anchored)", async () => {
    // Defensive case: a user (or a different bot) could quote our marker
    // string inside their own comment. The match MUST be anchored to the
    // body's prefix, otherwise we'd silently edit a stranger's comment.
    const existing = [
      {
        id: 100,
        body: `Someone wrote: "look at the marker ${STICKY_MARKER} — what does that do?"`,
      },
    ];
    const stubs: IssuesStubs = {
      listComments: vi.fn(),
      createComment: vi.fn().mockResolvedValue({ data: { id: 101 } }),
      updateComment: vi.fn(),
    };
    const octokit = makeOctokit(stubs, existing);

    await upsertComment({
      octokit,
      owner: "octo",
      repo: "demo",
      prNumber: 1,
      body: "audit body",
      mode: "sticky",
    });

    // Created (NOT edited #100 — that would clobber a user comment).
    expect(stubs.createComment).toHaveBeenCalledTimes(1);
    expect(stubs.updateComment).not.toHaveBeenCalled();
  });

  it("marker is HTML-comment-shaped so it renders invisibly in GitHub markdown", () => {
    // Cheap structural check — anchor against accidental refactors that
    // drop the `<!-- -->` framing (which would make the marker visible).
    expect(STICKY_MARKER.startsWith("<!--")).toBe(true);
    expect(STICKY_MARKER.endsWith("-->")).toBe(true);
    expect(STICKY_MARKER).toBe("<!-- glyph-audit-action:sticky -->");
  });
});
