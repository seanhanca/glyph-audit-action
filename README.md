# Glyph Chart Audit — GitHub Action

Audit chart specs on every PR. Posts a sticky comment with:

- the JSON diff
- audit findings (truncated axes, dual-y mismatch, small-n, ...)
- trust score (0–100)
- before / after SVG renders

> Status: **scaffolding (PR1/7)** — the action manifest, build pipeline, and
> entry stub are in place. Functional behavior lands in PR2–PR5. The Marketplace
> listing polish lands in PR6.

## Usage (preview — not yet functional)

```yaml
# .github/workflows/glyph-audit.yml
name: Glyph audit
on: pull_request

jobs:
  audit:
    runs-on: ubuntu-latest
    permissions:
      contents: read
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

## Inputs

| Name            | Default            | Description                                             |
| --------------- | ------------------ | ------------------------------------------------------- |
| `spec-pattern`  | `**/*.glyph.json`  | Glob for chart spec files                               |
| `glyph-version` | `latest`           | Version of `@glyph/cli` to use                          |
| `fail-on`       | `none`             | `none` \| `error` — exit nonzero on this severity       |
| `comment-mode`  | `sticky`           | `sticky` (one comment) \| `new` (per push)              |

## License

Apache 2.0.
