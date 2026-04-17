---
estimated_steps: 34
estimated_files: 4
skills_used: []
---

# T01: Enable Next.js standalone output and rewrite root Dockerfile as multi-stage pnpm build

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

## Inputs

- ``next.config.ts` — current Next.js config without standalone output`
- ``Dockerfile` — current single-stage npm Dockerfile`
- ``package.json` — root package.json without packageManager field`
- ``pnpm-workspace.yaml` — workspace config needed for pnpm install in Docker`
- ``.dockerignore` — current ignore patterns`

## Expected Output

- ``next.config.ts` — updated with output: "standalone"`
- ``Dockerfile` — rewritten as 3-stage pnpm multi-stage build with non-root user`
- ``package.json` — updated with packageManager field`
- ``.dockerignore` — verified/updated to not exclude pnpm-lock.yaml`

## Verification

grep -q 'standalone' next.config.ts && grep -q 'packageManager' package.json && grep -q 'AS runner' Dockerfile && grep -q 'USER nextjs' Dockerfile
