---
id: T01
parent: S02
milestone: M008
key_files:
  - next.config.ts
  - Dockerfile
  - package.json
key_decisions:
  - Used pnpm@10.32.1 (actual installed version) instead of planner-assumed 9.15.9
  - Removed openssh-client entirely — not needed in any stage for the Next.js app
  - Used corepack enable + corepack prepare for pnpm activation in Docker alpine images
duration: 
verification_result: passed
completed_at: 2026-04-17T12:39:23.787Z
blocker_discovered: false
---

# T01: Enable Next.js standalone output and rewrite root Dockerfile as multi-stage pnpm build with non-root user

**Enable Next.js standalone output and rewrite root Dockerfile as multi-stage pnpm build with non-root user**

## What Happened

Added `output: "standalone"` to next.config.ts so Next.js produces a self-contained `.next/standalone` directory with only the required node_modules. Added `packageManager: "pnpm@10.32.1"` to root package.json (using the actual installed version, not the planner's assumed 9.15.9). Rewrote the single-stage npm Dockerfile as a 3-stage pnpm build: deps (frozen lockfile install), builder (prisma generate + next build), runner (standalone output only with non-root nextjs:nodejs user). Removed openssh-client from the image entirely — it was only in the old single-stage build. Verified .dockerignore does not exclude pnpm-lock.yaml or services/. Docker build test could not run because Docker is not available in this Coder workspace — deferred to CI or local testing.

## Verification

Ran 5 grep-based verification checks: standalone in next.config.ts, packageManager in package.json, AS runner stage in Dockerfile, USER nextjs in Dockerfile, and no openssh-client in Dockerfile. All 5 passed. Docker build test skipped — Docker daemon not available in workspace.

## Verification Evidence

| # | Command | Exit Code | Verdict | Duration |
|---|---------|-----------|---------|----------|
| 1 | `grep -q 'standalone' next.config.ts` | 0 | ✅ pass | 10ms |
| 2 | `grep -q 'packageManager' package.json` | 0 | ✅ pass | 10ms |
| 3 | `grep -q 'AS runner' Dockerfile` | 0 | ✅ pass | 10ms |
| 4 | `grep -q 'USER nextjs' Dockerfile` | 0 | ✅ pass | 10ms |
| 5 | `grep -q 'openssh-client' Dockerfile (expect failure)` | 1 | ✅ pass (not found, as expected) | 10ms |

## Deviations

pnpm version corrected from 9.15.9 to 10.32.1 to match actual installed version. Docker build verification skipped due to no Docker daemon in workspace.

## Known Issues

Docker build not tested end-to-end — Docker is unavailable in this Coder workspace. The build should be verified in CI or a Docker-capable environment.

## Files Created/Modified

- `next.config.ts`
- `Dockerfile`
- `package.json`
