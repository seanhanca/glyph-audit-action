# Glyph Chart Audit — GitHub Action

> **Audit chart specs on every PR.**

Catch misleading charts before they ship. The action diffs Glyph chart specs in
your pull requests, runs audit rules against them, and posts a sticky comment
with everything a reviewer needs to spot a regression at a glance.

## Features

- **JSON diff** of every changed `*.glyph.json` spec — additions, removals,
  field-level edits.
- **Audit findings** — truncated axes, dual-y unit mismatch, small-n
  aggregations, misleading-color encodings, and more (full rule list in
  `@glyph/cli` docs).
- **Trust score** — single 0–100 number summarizing the chart's "is this
  honest?" rating, so reviewers can triage at a glance.
- **Before / after SVG renders** — both versions of every changed chart,
  rendered side-by-side directly in the PR comment.
- **Sticky comment** — one comment per PR, updated in place on every push, so
  the discussion stays clean.

## Usage

Drop this into `.github/workflows/glyph-audit.yml`:

```yaml
name: Glyph audit
on: pull_request

jobs:
  audit:
    runs-on: ubuntu-latest
    permissions:
      # `contents: write` lets the action push rendered SVGs to an orphan
      # `.glyph-audit` branch so the PR comment can embed them inline.
      contents: write
      pull-requests: write
    steps:
      - uses: actions/checkout@v4
        with: { fetch-depth: 0 }
      - uses: actions/setup-node@v4
        with: { node-version: "20" }
      - run: npm install -g @glyph/cli
      - uses: seanhanca/glyph-audit-action@v1
        with:
          spec-pattern: "**/*.glyph.json"
          fail-on: error
```

A ready-to-copy version of this workflow lives in
[`examples/.github/workflows/glyph-audit.yml`](./examples/.github/workflows/glyph-audit.yml).

## Inputs

| Name            | Default            | Description                                                                |
| --------------- | ------------------ | -------------------------------------------------------------------------- |
| `spec-pattern`  | `**/*.glyph.json`  | Glob pattern for chart spec files.                                         |
| `glyph-version` | `latest`           | Version of `@glyph/cli` to use.                                            |
| `fail-on`       | `none`             | `none` \| `error` — exit non-zero when an audit finding at this severity hits. |
| `comment-mode`  | `sticky`           | `sticky` (one comment, edited in place) \| `new` (a new comment per push). |

## Required permissions

The workflow's `GITHUB_TOKEN` needs:

- `contents: write` — to commit rendered SVGs to the `.glyph-audit` orphan
  branch (one subdir per PR head SHA, isolated from `main` history). The
  comment then links to
  `raw.githubusercontent.com/<owner>/<repo>/.glyph-audit/<sha>/<file>.svg`.
- `pull-requests: write` — to upsert the audit comment on the PR.

## What it looks like

> _Screenshot coming after the dogfood PR (PR7) lands on `seanhanca/glyph`._
> Until then, picture: a sticky PR comment with a trust-score badge at the top,
> a collapsible JSON diff, a bulleted list of audit findings color-coded by
> severity, and a two-column gallery of before/after SVG renders.
>
> ![Glyph Chart Audit PR comment (screenshot pending)](https://raw.githubusercontent.com/seanhanca/glyph-audit-action/main/docs/pr-comment-preview.png)

## Known limitations

- **Private repos** — `raw.githubusercontent.com` requires auth for private
  repos and won't render inline in PR comments. The action will still push the
  SVGs and rewrite the markdown, but the images will appear as broken links. A
  `comment-mode: inline-base64` fallback is on the roadmap.

## Releasing

For maintainers — how a new version reaches the GitHub Marketplace:

1. Bump `package.json` version, rebuild (`pnpm build`), and commit the
   refreshed `dist/` bundle. The release workflow refuses to publish if
   `dist/` is stale, so don't skip this.
2. Tag and push:
   ```bash
   git tag v0.1.0
   git push origin v0.1.0
   ```
   The `release` workflow in `.github/workflows/release.yml` fires on `v*`
   tags. It rebuilds, verifies `dist/` is committed, force-updates the major
   tag (e.g. `v1` → `v1.0.0`), and creates a GitHub Release via
   `softprops/action-gh-release@v2`.
3. In the GitHub UI: **Releases** → the freshly created draft → **"Publish this
   Action to the Marketplace"**. Pick categories **Code review** and **Code
   quality**. The icon (`bar-chart-2`) and color (`blue`) come from
   `action.yml` `branding`.

## License

Apache 2.0. See [`LICENSE`](./LICENSE).
