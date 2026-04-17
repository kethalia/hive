---
id: T02
parent: S02
milestone: M008
key_files:
  - services/terminal-proxy/Dockerfile
  - services/terminal-proxy/package.json
key_decisions:
  - Used pnpm deploy --filter for workspace-correct isolated production dependencies instead of plain pnpm install --prod
  - Used node --import tsx instead of npx tsx to avoid npx overhead in production
duration: 
verification_result: passed
completed_at: 2026-04-17T12:40:21.003Z
blocker_discovered: false
---

# T02: Rewrite terminal-proxy Dockerfile as multi-stage pnpm build with workspace deploy, non-root user, and tini init

**Rewrite terminal-proxy Dockerfile as multi-stage pnpm build with workspace deploy, non-root user, and tini init**

## What Happened

Moved `tsx` from devDependencies to dependencies in terminal-proxy's package.json since it's required at runtime (`node --import tsx`). Rewrote the Dockerfile from a single-stage npm build to a three-stage pnpm build designed for repo-root build context:

1. **deps** stage: enables corepack with pnpm@10.32.1 (matching root Dockerfile), copies workspace manifests and terminal-proxy package.json, runs `pnpm install --frozen-lockfile`
2. **deploy** stage: copies installed node_modules and terminal-proxy source, runs `pnpm deploy --filter hive-terminal-proxy --prod /deploy` to create a self-contained deployment directory with only production dependencies
3. **runner** stage: clean node:20-alpine with tini as PID 1, non-root appuser (uid 1001), copies the /deploy output, exposes port 3001, runs via `node --import tsx src/index.ts`

The Dockerfile assumes repo root as build context (T03 will update docker-compose to set this). Used the same pnpm version (10.32.1) and user pattern (gid/uid 1001) established in T01's root Dockerfile.

## Verification

Ran all 4 verification checks from the task plan — tsx in dependencies, AS runner stage, USER appuser, and tini presence. All passed with exit code 0.

## Verification Evidence

| # | Command | Exit Code | Verdict | Duration |
|---|---------|-----------|---------|----------|
| 1 | `node -e "const p=require('./services/terminal-proxy/package.json'); process.exit(p.dependencies?.tsx ? 0 : 1)"` | 0 | ✅ pass | 80ms |
| 2 | `grep -q 'AS runner' services/terminal-proxy/Dockerfile` | 0 | ✅ pass | 5ms |
| 3 | `grep -q 'USER appuser' services/terminal-proxy/Dockerfile` | 0 | ✅ pass | 5ms |
| 4 | `grep -q 'tini' services/terminal-proxy/Dockerfile` | 0 | ✅ pass | 5ms |

## Deviations

None

## Known Issues

None

## Files Created/Modified

- `services/terminal-proxy/Dockerfile`
- `services/terminal-proxy/package.json`
