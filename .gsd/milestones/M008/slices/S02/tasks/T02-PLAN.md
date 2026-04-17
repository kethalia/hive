---
estimated_steps: 25
estimated_files: 2
skills_used: []
---

# T02: Rewrite terminal-proxy Dockerfile as multi-stage pnpm build with workspace deploy

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

## Inputs

- ``services/terminal-proxy/Dockerfile` — current single-stage npm Dockerfile`
- ``services/terminal-proxy/package.json` — tsx in devDependencies`
- ``pnpm-workspace.yaml` — workspace config showing terminal-proxy as member`

## Expected Output

- ``services/terminal-proxy/Dockerfile` — rewritten as multi-stage pnpm build with non-root user and tini`
- ``services/terminal-proxy/package.json` — tsx moved to dependencies`

## Verification

grep -q 'AS runner' services/terminal-proxy/Dockerfile && grep -q 'USER appuser' services/terminal-proxy/Dockerfile && grep -q 'tini' services/terminal-proxy/Dockerfile
