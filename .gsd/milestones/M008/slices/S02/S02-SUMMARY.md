---
id: S02
parent: M008
milestone: M008
provides:
  - ["multi-stage-dockerfile-app: Root Dockerfile with standalone Next.js output", "multi-stage-dockerfile-terminal-proxy: Terminal-proxy Dockerfile with pnpm deploy", "compose-prod: Prod compose with GHCR image references for CI/CD", "compose-local: Local build compose with correct build contexts"]
requires:
  []
affects:
  []
key_files:
  - ["Dockerfile", "services/terminal-proxy/Dockerfile", "docker-compose.yml", "docker-compose.local.yml", "next.config.ts", "package.json", "services/terminal-proxy/package.json"]
key_decisions:
  - ["pnpm version pinned to 10.32.1 (actual installed) not planner-assumed 9.15.9", "Terminal-proxy uses pnpm deploy --filter for workspace-correct dependency isolation", "Prod compose uses GHCR images per D033 with restart: unless-stopped", "Terminal-proxy build context changed to repo root for pnpm workspace deploy compatibility"]
patterns_established:
  - ["Multi-stage Docker pattern: deps (corepack + frozen lockfile) -> build -> runner (non-root, minimal)", "corepack enable + corepack prepare pnpm@10.32.1 for pnpm activation in alpine images", "pnpm deploy --filter for workspace-correct isolated production dependencies in service Dockerfiles", "Compose file convention: docker-compose.yml (prod/GHCR), docker-compose.local.yml (build from source), docker-compose.dev.yml (infra only)"]
observability_surfaces:
  - none
drill_down_paths:
  []
duration: ""
verification_result: passed
completed_at: 2026-04-17T12:43:24.014Z
blocker_discovered: false
---

# S02: Dockerfile Upgrades & Compose Restructure

**Multi-stage pnpm Dockerfiles for both services with non-root users, standalone Next.js output, and restructured compose files (prod/local/dev).**

## What Happened

Three tasks delivered the full Docker and compose restructure for the Hive release pipeline.

**T01 — Root Dockerfile & Next.js Standalone Output.** Added `output: "standalone"` to next.config.ts so Next.js produces a self-contained `.next/standalone` directory with only required node_modules. Added `packageManager: "pnpm@10.32.1"` to root package.json (corrected from planner-assumed 9.15.9 to match actual installed version). Rewrote the single-stage npm Dockerfile as a 3-stage pnpm build: deps (corepack enable + frozen lockfile install), builder (prisma generate + next build), runner (standalone output only with non-root nextjs:nodejs user, uid/gid 1001). Removed openssh-client entirely from the image.

**T02 — Terminal-Proxy Dockerfile with pnpm Deploy.** Moved `tsx` from devDependencies to dependencies in terminal-proxy's package.json (required at runtime for `node --import tsx`). Rewrote the Dockerfile as a 3-stage build designed for repo-root context: deps (corepack with matching pnpm@10.32.1), deploy (`pnpm deploy --filter hive-terminal-proxy --prod /deploy` for workspace-correct isolated production dependencies), runner (clean alpine with tini as PID 1, non-root appuser uid 1001). Uses `node --import tsx` instead of npx tsx to avoid npx overhead.

**T03 — Compose File Restructure.** Renamed docker-compose.yml to docker-compose.local.yml via git mv, updated terminal-proxy build context from `./services/terminal-proxy` to repo root (`.`) with explicit dockerfile path — required because T02's Dockerfile uses pnpm workspace deploy from repo root. Created new prod docker-compose.yml referencing GHCR images (`ghcr.io/kethalia/hive:latest` and `ghcr.io/kethalia/hive-terminal-proxy:latest`) per D033, with `restart: unless-stopped` on app services and zero build directives. Dev compose left untouched. All three compose files validate cleanly.

**Key pattern:** Both Dockerfiles use identical corepack/pnpm activation (corepack enable + corepack prepare pnpm@10.32.1), same base image (node:20-alpine), same non-root user convention (uid/gid 1001), but different deployment strategies — standalone output for Next.js vs pnpm deploy for the workspace service.

## Verification

All 15 slice-level verification checks passed:

1. `grep -q 'standalone' next.config.ts` — exit 0 ✅
2. `grep -q 'packageManager' package.json` — exit 0 ✅
3. `grep -q 'AS runner' Dockerfile` — exit 0 ✅
4. `grep -q 'USER nextjs' Dockerfile` — exit 0 ✅
5. `node -e "...tsx in dependencies check..."` — exit 0 ✅
6. `grep -q 'AS runner' services/terminal-proxy/Dockerfile` — exit 0 ✅
7. `grep -q 'USER appuser' services/terminal-proxy/Dockerfile` — exit 0 ✅
8. `grep -q 'tini' services/terminal-proxy/Dockerfile` — exit 0 ✅
9. `test -f docker-compose.local.yml` — exit 0 ✅
10. `grep -q 'ghcr.io/kethalia/hive:latest' docker-compose.yml` — exit 0 ✅
11. `grep -q 'ghcr.io/kethalia/hive-terminal-proxy:latest' docker-compose.yml` — exit 0 ✅
12. `! grep -q 'build:' docker-compose.yml` — exit 0 (no build directives in prod) ✅
13. `docker compose config -q` — exit 0 (prod validates) ✅
14. `docker compose -f docker-compose.local.yml config -q` — exit 0 (local validates) ✅
15. `docker compose -f docker-compose.dev.yml config -q` — exit 0 (dev validates) ✅

Docker build not tested end-to-end — Docker daemon unavailable in this Coder workspace. Deferred to CI or Docker-capable environment.

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

pnpm version corrected from 9.15.9 to 10.32.1 to match actual installed version. No other deviations from plan.

## Known Limitations

Docker build not tested end-to-end — Docker daemon unavailable in Coder workspace. Build verification deferred to CI (S03) or a Docker-capable environment.

## Follow-ups

S03 (CI & Release Workflows) will add PR CI that builds both Docker images, closing the build verification gap.

## Files Created/Modified

- `next.config.ts` — Added output: standalone for self-contained Next.js builds
- `Dockerfile` — Rewrote as 3-stage pnpm build (deps/builder/runner) with non-root user
- `package.json` — Added packageManager field pinning pnpm@10.32.1
- `services/terminal-proxy/Dockerfile` — Rewrote as 3-stage pnpm deploy build with tini and non-root user
- `services/terminal-proxy/package.json` — Moved tsx from devDependencies to dependencies
- `docker-compose.yml` — New prod compose with GHCR images, no build directives
- `docker-compose.local.yml` — Renamed from docker-compose.yml, updated terminal-proxy build context to repo root
