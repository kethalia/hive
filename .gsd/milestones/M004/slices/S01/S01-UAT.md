# S01: Coder Template API Client & Staleness Engine — UAT

**Milestone:** M004
**Written:** 2026-04-13T23:04:46.358Z

# S01 UAT: Coder Template API Client & Staleness Engine

## Preconditions
- Node.js installed, `pnpm install` completed
- Access to hive repo with templates directory containing at least one template (e.g., `templates/hive-worker/`)
- For live Coder tests: `CODER_URL` and `CODER_SESSION_TOKEN` env vars set

## Test Cases

### TC1: Hash Stability
1. Run `pnpm vitest run src/__tests__/lib/templates/staleness.test.ts -t "stability"`
2. **Expected:** Both hashLocalTemplate and hashRemoteTar produce identical hashes on repeated calls with same input

### TC2: Stale Detection — Differing Content
1. Run `pnpm vitest run src/__tests__/lib/templates/staleness.test.ts -t "stale=true when hashes differ"`
2. **Expected:** compareTemplates returns `stale: true` when local files differ from remote tar content

### TC3: Current Detection — Matching Content
1. Run `pnpm vitest run src/__tests__/lib/templates/staleness.test.ts -t "stale=false when hashes match"`
2. **Expected:** compareTemplates returns `stale: false` when local files match remote tar content

### TC4: Graceful Degradation on Network Error
1. Run `pnpm vitest run src/__tests__/lib/templates/staleness.test.ts -t "graceful"`
2. **Expected:** compareTemplates returns `stale: false` (not throw) when Coder API is unreachable

### TC5: .terraform Exclusion
1. Run `pnpm vitest run src/__tests__/lib/templates/staleness.test.ts -t "terraform"`
2. **Expected:** hashLocalTemplate ignores `.terraform/` directory contents, hash is based only on user-authored files

### TC6: Tar Order Independence
1. Run `pnpm vitest run src/__tests__/lib/templates/staleness.test.ts -t "order"`
2. **Expected:** hashRemoteTar produces the same hash regardless of entry order in the tar buffer

### TC7: Full Regression Suite
1. Run `pnpm vitest run`
2. **Expected:** All 295 tests pass across 39 files with zero failures

### TC8: Live Coder Integration (manual, requires credentials)
1. Set `CODER_URL` and `CODER_SESSION_TOKEN` env vars
2. Import and call `compareTemplates(["hive-worker", "hive-verifier", "ai-dev", "docker-dev"])` from a Node REPL or test script
3. **Expected:** Returns array of 4 `TemplateStatus` objects, each with `name`, `stale` (boolean), `lastPushed` (string), `activeVersionId` (string), `localHash` (string), `remoteHash` (string)

## Edge Cases
- Template not found in Coder remote → should return `stale: true` (not in remote = assumed stale)
- Empty template directory → should still produce a valid hash
- Missing CODER_URL/CODER_SESSION_TOKEN → compareTemplates throws with clear env var error message
