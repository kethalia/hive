# S02 Research: Dockerfile Upgrades & Compose Restructure

## Current State

### Root Dockerfile (`/Dockerfile`)
- Single-stage, `node:20-alpine` base
- Uses `npm install --ignore-scripts` then copies everything
- Runs `npx prisma generate` and `npm run build` (Next.js)
- Exposes port 3000, runs `npm run start`
- No non-root user, no multi-stage optimization

### Terminal-Proxy Dockerfile (`/services/terminal-proxy/Dockerfile`)
- Single-stage, `node:20-alpine` base
- Uses `npm install --ignore-scripts` then copies everything
- No build step (runs via `tsx src/index.ts` at runtime)
- Exposes port 3001, runs `npm run start`
- No non-root user

### Current Compose Files
- `docker-compose.yml` — builds both `app` and `terminal-proxy` from source, includes postgres and redis with healthchecks and volumes
- `docker-compose.dev.yml` — postgres and redis only (custom ports 47964, 40744), used for local `pnpm dev`

### Workspace Structure (`pnpm-workspace.yaml`)
```yaml
packages:
  - "."
  - "services/*"
```
Root package is `hive-orchestrator`, workspace member is `hive-terminal-proxy`.

### Lockfile
- `pnpm-lock.yaml` exists, lockfileVersion 9.0 — pnpm is already the package manager

### .dockerignore Files
- Root: `node_modules`, `.next`, `.git`, `.gsd`, `ai-dev`, `web3-dev`
- Terminal-proxy: `node_modules`, `dist`, `*.tsbuildinfo`, `.env`, `.env.*`, `test`, `vitest.config.ts`, `tsconfig.json`

---

## Key Technical Findings

### 1. Next.js Standalone Output NOT Enabled
`next.config.ts` does NOT set `output: "standalone"`. This means `next start` requires the full `node_modules` and `.next` directory. For optimal Docker images, we should add `output: "standalone"` to `next.config.ts` — this produces a self-contained `.next/standalone` folder with only the needed deps. However, that is a **behavioral change** that may need separate validation. For this slice, we can proceed without it and optimize later, OR add it as part of the Dockerfile upgrade.

**Recommendation:** Add `output: "standalone"` to `next.config.ts`. This is the standard approach for Next.js Docker multi-stage builds (documented by Vercel). The standalone output copies only necessary files and includes a minimal `server.js`. The final stage then only needs: `.next/standalone`, `.next/static`, and `public/`.

### 2. Prisma Dependency
The root app requires `prisma generate` during build. The `prisma/schema.prisma` file must be present in the build stage. The generated client lives in `node_modules/.prisma/client`. With standalone output, Prisma client is included automatically.

### 3. Terminal-Proxy Runtime: tsx
Terminal-proxy uses `tsx` (TypeScript Execute) at runtime — `NODE_ENV=production tsx src/index.ts`. It does NOT compile to JS. This means:
- `tsx` must be available in the final image
- All source `.ts` files must be present
- `tsx` is a devDependency — with `pnpm deploy --prod`, it will NOT be included

**Options for terminal-proxy:**
- (a) Add a build step: compile TS to JS, run with `node dist/index.js` in prod — cleaner but requires adding a build script
- (b) Keep `tsx` as a regular dependency (move from devDependencies to dependencies)
- (c) Use `pnpm deploy` without `--prod` flag to include devDeps

**Recommendation:** Option (a) is cleanest for production. Add `"build": "tsc"` to terminal-proxy scripts, set `outDir: "dist"` (already in tsconfig), then run `node dist/index.js` in production. But the tsconfig has `"noEmit": true` — need to remove that for compilation OR use a separate tsconfig.build.json. Alternatively, option (b) is simpler — just move `tsx` to dependencies. Given scope constraints, **option (b) is pragmatic** for this slice.

### 4. pnpm deploy for Monorepo Docker Builds
`pnpm deploy` creates a standalone directory with a package's dependencies resolved from the monorepo. Usage:
```
pnpm --filter <package> deploy <target-dir>
```
This copies the package + all its prod dependencies into a flat directory. It is the recommended approach for monorepo Docker images.

For the root app (`hive-orchestrator`), since it IS the root package, `pnpm deploy` works but we need to be careful — root workspace packages can be tricky. Alternative: just use `pnpm install --frozen-lockfile --prod` in the final stage after building.

### 5. Base Image: `ghcr.io/kethalia/hive-base`
The hive-base image is a **heavy workspace image** (Debian trixie with Docker, Chrome, XFCE, Claude CLI, etc.). It is NOT suitable as a base for the app/proxy Dockerfiles. The app Dockerfiles should continue using `node:20-alpine` (or upgrade to `node:22-alpine`) as their base.

### 6. Environment Variables (Prod Compose)
The prod compose needs these env vars passed through:
- **app:** `DATABASE_URL`, `REDIS_URL`, `CODER_URL`, `CODER_SESSION_TOKEN`, `NEXT_PUBLIC_TERMINAL_WS_URL`
- **terminal-proxy:** `CODER_URL`, `CODER_AGENT_URL`, `CODER_SESSION_TOKEN`

---

## Proposed Multi-Stage Dockerfile: Root App

```dockerfile
# Stage 1: deps
FROM node:20-alpine AS deps
RUN corepack enable && corepack prepare pnpm@latest --activate
WORKDIR /app
COPY pnpm-lock.yaml package.json pnpm-workspace.yaml ./
COPY services/terminal-proxy/package.json services/terminal-proxy/
COPY prisma ./prisma/
RUN pnpm install --frozen-lockfile

# Stage 2: build
FROM node:20-alpine AS builder
RUN corepack enable && corepack prepare pnpm@latest --activate
RUN apk add --no-cache openssh-client
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN pnpm prisma generate
RUN pnpm build

# Stage 3: runner
FROM node:20-alpine AS runner
RUN addgroup --system --gid 1001 nodejs && adduser --system --uid 1001 nextjs
WORKDIR /app
ENV NODE_ENV=production
ENV HOSTNAME=0.0.0.0
# If standalone output enabled:
COPY --from=builder /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
USER nextjs
EXPOSE 3000
CMD ["node", "server.js"]
```

**Note:** If we do NOT add `output: "standalone"`, the runner stage needs full node_modules and .next, which largely defeats multi-stage benefits. Strongly recommend adding standalone output.

## Proposed Multi-Stage Dockerfile: Terminal-Proxy

```dockerfile
# Stage 1: deps
FROM node:20-alpine AS deps
RUN corepack enable && corepack prepare pnpm@latest --activate
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --prod

# Stage 2: runner
FROM node:20-alpine AS runner
RUN apk add --no-cache tini
RUN addgroup --system --gid 1001 appgroup && adduser --system --uid 1001 appuser
WORKDIR /app
ENV NODE_ENV=production
ENV BIND_HOST=0.0.0.0
COPY --from=deps /app/node_modules ./node_modules
COPY src ./src
COPY package.json ./
USER appuser
EXPOSE 3001
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "--import", "tsx", "src/index.ts"]
```

**Issue:** Terminal-proxy is a workspace member. Its `pnpm-lock.yaml` is at the root. We need to either:
- Copy the root lockfile and workspace config, then `pnpm --filter hive-terminal-proxy install`
- Or use `pnpm deploy --filter hive-terminal-proxy /app/deploy` in a build stage

**Recommendation:** Use `pnpm deploy` approach — copy entire workspace context into build stage, run `pnpm deploy --filter hive-terminal-proxy /deploy`, then copy `/deploy` into the final runner stage. This handles workspace resolution correctly. Since tsx is needed at runtime, either move it to dependencies or install it globally in the runner.

---

## Compose Restructure Plan

### `docker-compose.local.yml` (renamed from current `docker-compose.yml`)
- Identical structure to current `docker-compose.yml` — builds from source
- Both `app` and `terminal-proxy` use `build:` directives
- Includes postgres + redis with healthchecks

### `docker-compose.yml` (new, prod)
- `app` uses `image: ghcr.io/kethalia/hive:latest` (no build directive)
- `terminal-proxy` uses `image: ghcr.io/kethalia/hive-terminal-proxy:latest`
- Same postgres/redis config
- Same env var passthrough
- Add `restart: unless-stopped` for prod resilience

### `docker-compose.dev.yml` (unchanged)
- Postgres + redis only, stays exactly as-is

---

## Risks & Open Questions

1. **Standalone output change** — Adding `output: "standalone"` to `next.config.ts` changes how the app is served. Need to verify static assets (public/, .next/static) are served correctly. This is well-documented by Vercel and widely used, so risk is low.

2. **pnpm deploy for root package** — `pnpm deploy` with the root workspace package can behave differently than for nested packages. Need to test. Alternative: skip `pnpm deploy` for the root app and just do a standard multi-stage with `pnpm install --frozen-lockfile` in deps stage.

3. **tsx in production for terminal-proxy** — Running TypeScript via tsx in production adds overhead vs compiled JS. Acceptable for now but worth noting. Moving tsx from devDependencies to dependencies is the simplest path.

4. **pnpm version pinning** — Should pin pnpm version in Dockerfiles (e.g., `pnpm@9.15.0`) rather than `@latest` for reproducibility. Check `packageManager` field in root package.json (currently not set — should add it).

5. **openssh-client** — Root Dockerfile installs `openssh-client`. Check if still needed; if so, include in the builder stage only (not runner).

6. **.dockerignore updates** — Root `.dockerignore` needs `services/` excluded? No — the root Dockerfile needs the full workspace context for pnpm workspace resolution. May need to update `.dockerignore` to include `pnpm-lock.yaml` (ensure it's NOT ignored).

---

## Implementation Checklist

1. Add `output: "standalone"` to `next.config.ts`
2. Rewrite root `Dockerfile` as multi-stage pnpm with non-root user
3. Rewrite `services/terminal-proxy/Dockerfile` as multi-stage pnpm with non-root user
4. Move `tsx` to dependencies in terminal-proxy `package.json` (or add build step)
5. Rename `docker-compose.yml` to `docker-compose.local.yml`
6. Create new `docker-compose.yml` (prod, GHCR images)
7. Update root `package.json` scripts that reference `docker-compose.yml` (none found — the dev scripts use `-f docker-compose.dev.yml`)
8. Update `.dockerignore` files if needed
9. Add `packageManager` field to root `package.json` for pnpm version pinning
10. Validate: `docker compose -f docker-compose.local.yml build` succeeds
11. Validate: `docker compose config` on prod compose
12. Validate: `docker compose -f docker-compose.dev.yml up` unchanged
