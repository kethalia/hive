---
id: S01
parent: M008
milestone: M008
provides:
  - ["changesets-configured: pnpm changeset and pnpm changeset:version available for version management"]
requires:
  []
affects:
  - ["S03: CI & Release Workflows depends on changesets being configured here"]
key_files:
  - [".changeset/config.json", ".changeset/README.md", "package.json", "pnpm-lock.yaml"]
key_decisions:
  - ["Used built-in @changesets/cli/changelog instead of @changesets/changelog-github to avoid GitHub token requirement"]
patterns_established:
  - ["Changesets for version tracking only (no npm publish) — versions drive Docker image tags in S03"]
observability_surfaces:
  - none
drill_down_paths:
  []
duration: ""
verification_result: passed
completed_at: 2026-04-17T12:34:20.898Z
blocker_discovered: false
---

# S01: Changesets Setup

**Installed @changesets/cli with independent versioning configured for both private packages, no npm publish capability.**

## What Happened

Installed @changesets/cli ^2.30.0 as a root devDependency and ran `pnpm changeset init` to scaffold the `.changeset/` directory. Configured `.changeset/config.json` for independent versioning (`fixed: []` per D032), restricted access to prevent accidental npm publish (per D034), and `privatePackages: { version: true, tag: true }` so version bumps apply to both private packages (hive-orchestrator at root, hive-terminal-proxy at services/terminal-proxy). Used the built-in `@changesets/cli/changelog` generator instead of `@changesets/changelog-github` to avoid requiring a GitHub token — the changelog is only used for local version tracking, not public release notes. Added two convenience scripts to root package.json: `changeset` and `changeset:version`.

This is a single-task slice — the scope was small and self-contained. All work completed in T01 with no blockers or deviations.

## Verification

All three verification checks passed:
1. `pnpm changeset --help` exits 0 — CLI is callable (1200ms)
2. Node assert on config.json confirmed: access=restricted, fixed=[], privatePackages.version=true, baseBranch=main
3. Node assert on package.json confirmed both `changeset` and `changeset:version` scripts exist

Additionally verified `.changeset/config.json` and `.changeset/README.md` files exist on disk.

## Requirements Advanced

None.

## Requirements Validated

None.

## New Requirements Surfaced

None.

## Requirements Invalidated or Re-scoped

None.

## Operational Readiness

None.

## Deviations

None — default changeset init config already matched most target values, only needed to add privatePackages field.

## Known Limitations

None for this slice scope.

## Follow-ups

None.

## Files Created/Modified

- `package.json` — Added changeset and changeset:version scripts
- `.changeset/config.json` — Changesets config: independent versioning, restricted access, private package support
- `.changeset/README.md` — Default changesets README scaffolded by init
- `pnpm-lock.yaml` — Updated with @changesets/cli dependency tree
