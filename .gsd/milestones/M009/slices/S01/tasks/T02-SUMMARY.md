---
id: T02
parent: S01
milestone: M009
key_files:
  - src/__tests__/lib/templates/sync-vault.test.ts
key_decisions:
  - Replaced 4 symlink tests with a single recursive no-symlink assertion that walks all target directories
  - Added independent per-directory manifest and stale-cleanup tests to verify the new per-target manifest design
duration: 
verification_result: passed
completed_at: 2026-04-18T14:17:04.375Z
blocker_discovered: false
---

# T02: Rewrite sync-vault tests for 3-target sync, per-directory manifest cleanup, and no-symlink verification

**Rewrite sync-vault tests for 3-target sync, per-directory manifest cleanup, and no-symlink verification**

## What Happened

Rewrote `src/__tests__/lib/templates/sync-vault.test.ts` to match the T01 refactored script behavior:

1. **Replaced `gsdDir` with `agentsConvDir` and `piDir`** — all references to `~/.gsd/agent/` removed from tests.
2. **CLAUDE.md tests** — now assert content lands in all 3 targets (`~/.claude/`, `~/.agents/`, `~/.pi/agent/`). Overwrite and preserve-on-missing tests updated for 3 targets.
3. **AGENTS.md tests** — same 3-target assertion pattern applied.
4. **Skills tests** — updated to verify skills land in all 3 skill directories. Added two new tests: (a) each target has its own independent `.vault-managed` manifest, (b) stale cleanup works independently per directory (one target has stale skill, others don't — only the stale one gets cleaned).
5. **Deleted GSD skills symlink block** (4 tests removed). Replaced with a "No symlinks" describe block containing a recursive `lstat`-based test that walks all 3 target directories and asserts zero symlinks exist.
6. **`beforeEach` does NOT pre-create `agentsConvDir` or `piDir`** — the script's `mkdir -p` handles directory creation, which the tests implicitly verify.

## Verification

Ran `pnpm vitest run src/__tests__/lib/templates/sync-vault.test.ts` — all 16 tests passed in 162ms.

## Verification Evidence

| # | Command | Exit Code | Verdict | Duration |
|---|---------|-----------|---------|----------|
| 1 | `pnpm vitest run src/__tests__/lib/templates/sync-vault.test.ts` | 0 | ✅ pass — 16/16 tests passed | 322ms |

## Deviations

None

## Known Issues

None

## Files Created/Modified

- `src/__tests__/lib/templates/sync-vault.test.ts`
