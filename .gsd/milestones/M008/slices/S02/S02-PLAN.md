# S02: Dockerfile Upgrades & Compose Restructure

**Goal:** Multi-stage pnpm Dockerfiles for both services with non-root users, standalone Next.js output, and restructured compose files (prod default, local builds via -f flag, dev unchanged).
**Demo:** docker compose -f docker-compose.local.yml build succeeds with multi-stage pnpm builds; docker compose config validates prod compose; dev compose unchanged

## Must-Haves

- `docker compose -f docker-compose.local.yml build` succeeds with multi-stage pnpm builds
- `docker compose config` validates prod compose with GHCR image references
- `docker compose -f docker-compose.dev.yml config` unchanged
- Root Dockerfile uses 3-stage build (deps → builder → runner) with non-root user
- Terminal-proxy Dockerfile uses multi-stage build with pnpm deploy and non-root user
- `next.config.ts` has `output: "standalone"`
- Root `package.json` has `packageManager` field pinning pnpm version

## Proof Level

- This slice proves: This slice proves: operational. Real runtime required: yes (Docker build). Human/UAT required: no.

## Integration Closure

Upstream surfaces consumed: `next.config.ts`, `package.json`, `pnpm-workspace.yaml`, `prisma/schema.prisma`, `services/terminal-proxy/package.json`. New wiring: standalone Next.js output changes how the app is served in Docker (server.js entrypoint instead of next start). What remains: CI/CD pipeline (S03) to build and push images to GHCR.

## Verification

- Not provided.

## Tasks

- [x] **T01: Enable Next.js standalone output and rewrite root Dockerfile as multi-stage pnpm build** `est:45m`
  ## Description

The root Dockerfile is single-stage, uses npm, has no non-root user, and copies the entire working directory. This task adds `output: "standalone"` to next.config.ts (producing a self-contained `.next/standalone` with minimal deps), adds `packageManager` to root package.json for pnpm version pinning, and rewrites the Dockerfile as a 3-stage build:

1. **deps** — install all dependencies with pnpm frozen lockfile
2. **builder** — copy source, run prisma generate + next build
3. **runner** — copy only `.next/standalone`, `.next/static`, and `public/` with a non-root user

The standalone output is the standard Vercel-documented approach for Next.js Docker images. It automatically includes only the needed node_modules (including Prisma client) in the standalone folder.

## Steps

1. Add `output: "standalone"` to the nextConfig object in `next.config.ts`
2. Add `"packageManager": "pnpm@9.15.9"` to root `package.json` (check actual installed version with `pnpm --version`)
3. Rewrite `Dockerfile` as multi-stage:
   - Stage 1 (deps): `node:20-alpine`, enable corepack, copy `pnpm-lock.yaml`, `package.json`, `pnpm-workspace.yaml`, `services/terminal-proxy/package.json`, and `prisma/` directory, run `pnpm install --frozen-lockfile`
   - Stage 2 (builder): `node:20-alpine`, enable corepack, copy node_modules from deps, copy full source, run `pnpm prisma generate` then `pnpm build`
   - Stage 3 (runner): `node:20-alpine`, create nodejs group (gid 1001) and nextjs user (uid 1001), set NODE_ENV=production and HOSTNAME=0.0.0.0, copy `public/` from builder, copy `.next/standalone` from builder (chown nextjs:nodejs), copy `.next/static` from builder (chown nextjs:nodejs) to `.next/static`, switch to USER nextjs, expose 3000, CMD ["node", "server.js"]
4. Update root `.dockerignore` to ensure `pnpm-lock.yaml` is NOT ignored (it currently isn't, but verify). Add `pnpm-lock.yaml` is present. Also ensure `services/` is NOT ignored since the workspace needs it for resolution.
5. Verify: `docker compose -f docker-compose.local.yml build app` succeeds (or at minimum `docker build -t hive-test .` succeeds)

## Must-Haves

- [x] `next.config.ts` has `output: "standalone"`
- [x] `package.json` has `packageManager` field
- [x] Dockerfile is multi-stage with deps, builder, runner stages
- [x] Runner stage uses non-root user (nextjs:nodejs)
- [x] Runner stage only contains standalone output + static + public
- [x] No openssh-client in runner stage (builder only if needed)

## Verification

- `grep -q 'standalone' next.config.ts` exits 0
- `grep -q 'packageManager' package.json` exits 0
- `grep -q 'AS runner' Dockerfile` exits 0
- `grep -q 'USER nextjs' Dockerfile` exits 0
- `docker build -t hive-app-test .` succeeds (if Docker available)

## Failure Modes

| Dependency | On error | On timeout | On malformed response |
|------------|----------|-----------|----------------------|
| pnpm install --frozen-lockfile | Fails if lockfile is stale — run `pnpm install` to regenerate | N/A | N/A |
| next build with standalone | Fails if app code has issues — check build logs | N/A | N/A |
| prisma generate | Fails if schema.prisma missing from deps stage — ensure COPY prisma/ | N/A | N/A |
  - Files: `next.config.ts`, `Dockerfile`, `package.json`, `.dockerignore`
  - Verify: grep -q 'standalone' next.config.ts && grep -q 'packageManager' package.json && grep -q 'AS runner' Dockerfile && grep -q 'USER nextjs' Dockerfile

- [x] **T02: Rewrite terminal-proxy Dockerfile as multi-stage pnpm build with workspace deploy** `est:30m`
  ## Description

The terminal-proxy Dockerfile is single-stage, uses npm, and has no non-root user. Since terminal-proxy is a pnpm workspace member (`hive-terminal-proxy`), we need the workspace context for dependency resolution. The approach:

1. Move `tsx` from devDependencies to dependencies in terminal-proxy package.json (it's needed at runtime since the service runs via `tsx src/index.ts`)
2. Rewrite the Dockerfile to build from the workspace root context, using `pnpm deploy --filter hive-terminal-proxy` to create a standalone deployment directory
3. Add non-root user

Since the terminal-proxy Dockerfile currently has `context: ./services/terminal-proxy` in docker-compose.yml, we need to change the build context to the repo root and point to the terminal-proxy Dockerfile. This will be handled in T03 (compose restructure), but the Dockerfile itself must be written to work from the repo root context.

**Important:** The terminal-proxy .dockerignore excludes `tsconfig.json` — but since we're changing the build context to repo root, the root `.dockerignore` will apply instead. The terminal-proxy `.dockerignore` becomes irrelevant for Docker builds (but keep it for other tooling).

## Steps

1. In `services/terminal-proxy/package.json`, move `tsx` from `devDependencies` to `dependencies`
2. Rewrite `services/terminal-proxy/Dockerfile` as multi-stage, designed to run from repo root context:
   - Stage 1 (deps): `node:20-alpine`, enable corepack, copy `pnpm-lock.yaml`, `package.json`, `pnpm-workspace.yaml`, `services/terminal-proxy/package.json`, run `pnpm install --frozen-lockfile`
   - Stage 2 (deploy): copy node_modules from deps, copy `services/terminal-proxy/` source, run `pnpm deploy --filter hive-terminal-proxy --prod /deploy`
   - Stage 3 (runner): `node:20-alpine`, add tini, create appgroup (gid 1001) and appuser (uid 1001), copy `/deploy` from deploy stage, set NODE_ENV=production BIND_HOST=0.0.0.0, USER appuser, expose 3001, ENTRYPOINT ["tini", "--"], CMD ["node", "--import", "tsx", "src/index.ts"]
3. Verify: `grep -q 'AS runner' services/terminal-proxy/Dockerfile` exits 0

## Must-Haves

- [x] tsx moved to dependencies in terminal-proxy package.json
- [x] Dockerfile is multi-stage with non-root user
- [x] Uses pnpm deploy for workspace-correct dependency resolution
- [x] Uses tini as init process
- [x] Works with repo root as build context

## Verification

- `node -e "const p=require('./services/terminal-proxy/package.json'); process.exit(p.dependencies?.tsx ? 0 : 1)"` exits 0
- `grep -q 'AS runner' services/terminal-proxy/Dockerfile` exits 0
- `grep -q 'USER appuser' services/terminal-proxy/Dockerfile` exits 0
- `grep -q 'tini' services/terminal-proxy/Dockerfile` exits 0
  - Files: `services/terminal-proxy/Dockerfile`, `services/terminal-proxy/package.json`
  - Verify: grep -q 'AS runner' services/terminal-proxy/Dockerfile && grep -q 'USER appuser' services/terminal-proxy/Dockerfile && grep -q 'tini' services/terminal-proxy/Dockerfile

- [x] **T03: Restructure compose files: rename local, create prod, update build contexts** `est:30m`
  ## Description

Per decision D035, the compose files should be:
- `docker-compose.yml` — prod (references GHCR published images, no build directives)
- `docker-compose.local.yml` — builds from source (current docker-compose.yml content with updated build contexts)
- `docker-compose.dev.yml` — unchanged (postgres + redis only)

This task renames the existing docker-compose.yml to docker-compose.local.yml, updates it to use correct build contexts (terminal-proxy needs repo root context now), and creates a new prod docker-compose.yml.

## Steps

1. Rename `docker-compose.yml` to `docker-compose.local.yml` (use `git mv`)
2. In `docker-compose.local.yml`, update the terminal-proxy build section:
   - Change `context: ./services/terminal-proxy` to `context: .`
   - Change `dockerfile: Dockerfile` to `dockerfile: services/terminal-proxy/Dockerfile`
   - Keep all other settings (ports, environment) identical
3. Create new `docker-compose.yml` (prod):
   - `app` service: `image: ghcr.io/kethalia/hive:latest` (per D033), same ports/depends_on/environment as local but NO build directive
   - `terminal-proxy` service: `image: ghcr.io/kethalia/hive-terminal-proxy:latest` (per D033), same ports/environment but NO build directive
   - Same postgres and redis services with healthchecks and volumes
   - Add `restart: unless-stopped` to app and terminal-proxy services
4. Verify `docker compose config` validates (prod)
5. Verify `docker compose -f docker-compose.local.yml config` validates (local)
6. Verify `docker compose -f docker-compose.dev.yml config` validates (dev, unchanged)

## Must-Haves

- [x] docker-compose.local.yml has build directives and correct contexts
- [x] docker-compose.yml (prod) uses GHCR images per D033, no build directives
- [x] docker-compose.dev.yml is untouched
- [x] All three compose files validate with `docker compose config`
- [x] Prod compose has `restart: unless-stopped` on app services

## Verification

- `test -f docker-compose.local.yml` exits 0
- `grep -q 'ghcr.io/kethalia/hive:latest' docker-compose.yml` exits 0
- `grep -q 'ghcr.io/kethalia/hive-terminal-proxy:latest' docker-compose.yml` exits 0
- `! grep -q 'build:' docker-compose.yml` exits 0 (no build directives in prod)
- `grep -q 'build:' docker-compose.local.yml` exits 0 (has build directives)
- `docker compose config -q` exits 0
- `docker compose -f docker-compose.local.yml config -q` exits 0
- `docker compose -f docker-compose.dev.yml config -q` exits 0
  - Files: `docker-compose.yml`, `docker-compose.local.yml`, `docker-compose.dev.yml`
  - Verify: test -f docker-compose.local.yml && grep -q 'ghcr.io/kethalia/hive:latest' docker-compose.yml && grep -q 'ghcr.io/kethalia/hive-terminal-proxy:latest' docker-compose.yml && docker compose config -q && docker compose -f docker-compose.local.yml config -q && docker compose -f docker-compose.dev.yml config -q

## Files Likely Touched

- next.config.ts
- Dockerfile
- package.json
- .dockerignore
- services/terminal-proxy/Dockerfile
- services/terminal-proxy/package.json
- docker-compose.yml
- docker-compose.local.yml
- docker-compose.dev.yml
