---
id: T01
parent: S01
milestone: M008
key_files:
  - package.json
  - .changeset/config.json
  - .changeset/README.md
  - pnpm-lock.yaml
key_decisions:
  - Used built-in @changesets/cli/changelog instead of @changesets/changelog-github to avoid GitHub token requirement
duration: 
verification_result: passed
completed_at: 2026-04-17T12:33:21.916Z
blocker_discovered: false
---

# T01: Install @changesets/cli, configure independent versioning for private packages, add convenience scripts

**Install @changesets/cli, configure independent versioning for private packages, add convenience scripts**

## What Happened

Installed @changesets/cli ^2.30.0 as a root devDependency via `pnpm add -Dw`. Ran `pnpm changeset init` to scaffold the `.changeset/` directory with default config and README. Updated `.changeset/config.json` to add `privatePackages: { version: true, tag: true }` per D034 (no npm publish, version tracking only). The default init already set `access: restricted`, `fixed: []` (independent versioning per D032), `baseBranch: main`, and `commit: false`. Added `changeset` and `changeset:version` scripts to root `package.json`.

## Verification

Ran three verification checks: (1) `pnpm changeset --help` confirmed CLI is callable, (2) Node assert on config.json confirmed access=restricted, fixed=[], privatePackages.version=true, baseBranch=main, (3) Node assert on package.json confirmed both changeset scripts exist.

## Verification Evidence

| # | Command | Exit Code | Verdict | Duration |
|---|---------|-----------|---------|----------|
| 1 | `pnpm changeset --help` | 0 | ✅ pass | 1200ms |
| 2 | `node -e "assert config.json values"` | 0 | ✅ pass | 100ms |
| 3 | `node -e "assert package.json scripts"` | 0 | ✅ pass | 80ms |

## Deviations

None — default init config already matched most target values, only needed to add privatePackages field.

## Known Issues

None

## Files Created/Modified

- `package.json`
- `.changeset/config.json`
- `.changeset/README.md`
- `pnpm-lock.yaml`
