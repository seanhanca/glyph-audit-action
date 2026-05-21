# Glyph Chart Audit — GitHub Action

> **Audit chart specs on every PR.**

Catch misleading charts before they ship. The action audits every Glyph chart
spec in your repository on every pull request, posts a sticky comment with the
findings and a structural spec diff, and (optionally) fails the build when a
severity threshold is breached.

## Features

- **Audit findings** — flags truncated y-axes, dual-axis layers,
  undisclosed log scales, sparse aggregations, diverging palettes without an
  explicit midpoint, extreme aspect ratios, and more (8 rules, see below).
- **Severity gating** — `fail-on: error` blocks merge on a HIGH finding,
  `warning` includes MEDIUM, `any` blocks on any finding, `none` is
  comment-only.
- **Spec diff** — added/removed/changed fields between the PR's base and
  head versions of every changed spec, rendered as a collapsible block.
- **Sticky comment** — one comment per PR, updated in place on every push,
  so the discussion stays clean.
- **Zero runtime deps** — the audit + diff logic is bundled into the action.
  No `npm install` step in your workflow.

## Usage

Drop this into `.github/workflows/glyph-audit.yml`:

```yaml
name: Glyph audit
on: pull_request

jobs:
  audit:
    runs-on: ubuntu-latest
    permissions:
      pull-requests: write
    steps:
      - uses: actions/checkout@v4
      - uses: seanhanca/glyph-audit-action@v0.2
        with:
          spec-pattern: "**/*.glyph.json"
          fail-on: error
```

A ready-to-copy version of this workflow lives in
[`examples/.github/workflows/glyph-audit.yml`](./examples/.github/workflows/glyph-audit.yml).

## Inputs

| Name           | Default            | Description                                                                              |
| -------------- | ------------------ | ---------------------------------------------------------------------------------------- |
| `spec-pattern` | `**/*.glyph.json`  | Glob pattern for chart spec files (matched against every file at HEAD).                  |
| `fail-on`      | `error`            | Severity threshold. `error` \| `warning` \| `any` \| `none`. See [Failure modes](#failure-modes).   |
| `comment-mode` | `sticky`           | `sticky` (one comment, edited in place) \| `new` (a new comment per push).               |
| `github-token` | `${{ github.token }}` | Token used to read PR files and post the comment.                                     |

## Audit rules

| Rule       | Severity | What it flags                                                              |
| ---------- | -------- | -------------------------------------------------------------------------- |
| `AUDIT-01` | HIGH     | Bar chart with y-axis not starting at 0 — bar heights misrepresent magnitude. |
| `AUDIT-02` | MEDIUM   | Dual-axis layers — left + right y axes, hard to compare visually.          |
| `AUDIT-03` | HIGH     | Logarithmic y scale without `log` in the chart title.                      |
| `AUDIT-04` | MEDIUM   | Excessive aggregation (fewer than 5 underlying rows per bar).              |
| `AUDIT-06` | LOW      | More than 8 categorical colors — readers can't reliably distinguish them.  |
| `AUDIT-07` | LOW      | Extreme aspect ratio (width:height < 0.5 or > 3).                          |
| `AUDIT-08` | MEDIUM   | Diverging palette without an explicit midpoint declared.                   |
| `AUDIT-09` | MEDIUM   | Multi-layer bar chart whose y domain crosses zero (stacking is ambiguous). |

## Failure modes

`fail-on` controls when the action exits non-zero. The comment is **always**
posted first, so reviewers see the findings even on a red build.

- `error` (default) — fail when any HIGH finding is present.
- `warning` — fail when HIGH or MEDIUM findings are present.
- `any` — fail when there's at least one finding.
- `none` — comment-only; never fails on findings.

## What it looks like

The sticky comment opens with a one-line summary (number of specs audited,
head SHA, total finding count), then one section per spec. Each section has:

- A collapsible `<details>` block with the spec diff (added / removed /
  changed JSON paths).
- An `### Audit findings` heading, the per-severity count line (e.g.
  `**3 findings**: 1 HIGH, 1 MEDIUM, 1 LOW.`), and a markdown table with
  `Rule | Severity | Path | Message` columns.

Severity is rendered as plain text (`**HIGH**`), not emoji — so you can
grep / filter the comment body from automation.

## Required permissions

The workflow's `GITHUB_TOKEN` needs `pull-requests: write` to post (or update)
the sticky comment. The action reads file contents via the contents API; the
default token already has `contents: read` on the calling repo.

## Migrating from v0.1

v0.1.0 shelled out to `@glyph/cli`'s `glyph diff` for the structural diff,
and the `fail-on` input was declared but never read. v0.2 changes that:

- **No more `npm install -g @glyph/cli`** — drop that step. The audit + diff
  run in-process, bundled into `dist/index.js`.
- **`fail-on` is now honored.** The default changed from `none` → `error`.
  Set `fail-on: none` if you want the old comment-only behavior.
- **The `glyph-version` input is gone.** Pinning the CLI version is no
  longer meaningful; pin the action by tag instead (`@v0.2`, `@v0.2.0`).
- **Audit runs on every matching spec at HEAD**, not just specs touched by
  the PR. New chart files now get a clean first audit.
- **SVG before/after renders** (a v0.1 feature that depended on the CLI's
  `--image-dir` output) are gone for v0.2. The roadmap reintroduces them
  once `@glyph/core` has a published npm package.

## Releasing

For maintainers — how a new version reaches the GitHub Marketplace:

1. Bump `package.json` version, rebuild (`pnpm build`), and commit the
   refreshed `dist/` bundle. The release workflow refuses to publish if
   `dist/` is stale, so don't skip this.
2. Tag and push:
   ```bash
   git tag v0.2.0
   git push origin v0.2.0
   ```
   The `release` workflow in `.github/workflows/release.yml` fires on `v*`
   tags. It rebuilds, verifies `dist/` is committed, force-updates the major
   tag (e.g. `v0` → `v0.2.0`), and creates a GitHub Release.
3. In the GitHub UI: **Releases** → the freshly created draft → **"Publish this
   Action to the Marketplace"**. Pick categories **Code review** and **Code
   quality**. The icon (`bar-chart-2`) and color (`blue`) come from
   `action.yml` `branding`.

## License

Apache 2.0. See [`LICENSE`](./LICENSE).
