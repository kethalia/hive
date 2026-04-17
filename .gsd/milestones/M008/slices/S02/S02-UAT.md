# S02: Dockerfile Upgrades & Compose Restructure — UAT

**Milestone:** M008
**Written:** 2026-04-17T12:43:24.014Z

# S02 UAT: Dockerfile Upgrades & Compose Restructure

## Preconditions
- Docker daemon available (not available in Coder workspace — run on a Docker-capable machine)
- Repository cloned with all S02 changes applied
- pnpm installed (version 10.32.1)

## Test Cases

### TC1: Root Dockerfile Multi-Stage Build
**Steps:**
1. Run `docker build -t hive-app-test .` from repo root
2. Verify build completes without errors
3. Run `docker inspect hive-app-test --format '{{.Config.User}}'`
4. Verify output is `nextjs`
5. Run `docker run --rm hive-app-test ls /app/server.js`
6. Verify server.js exists (standalone output)
7. Run `docker run --rm hive-app-test ls /app/.next/static`
8. Verify static assets are present

**Expected:** Build succeeds, runs as non-root nextjs user, contains only standalone output.

### TC2: Terminal-Proxy Dockerfile Multi-Stage Build
**Steps:**
1. Run `docker build -f services/terminal-proxy/Dockerfile -t hive-proxy-test .` from repo root
2. Verify build completes without errors
3. Run `docker inspect hive-proxy-test --format '{{.Config.User}}'`
4. Verify output is `appuser`
5. Run `docker inspect hive-proxy-test --format '{{.Config.Entrypoint}}'`
6. Verify entrypoint includes `tini`
7. Run `docker run --rm hive-proxy-test ls /deploy/node_modules/tsx`
8. Verify tsx is present in production dependencies

**Expected:** Build succeeds, runs as non-root appuser, uses tini as PID 1, has tsx in production deps.

### TC3: Prod Compose Validation
**Steps:**
1. Run `docker compose config` from repo root
2. Verify no build directives appear in output
3. Verify `ghcr.io/kethalia/hive:latest` appears for app service
4. Verify `ghcr.io/kethalia/hive-terminal-proxy:latest` appears for terminal-proxy service
5. Verify `restart: unless-stopped` on app and terminal-proxy services
6. Verify postgres and redis services have healthchecks

**Expected:** Valid compose config with GHCR images, restart policies, no build directives.

### TC4: Local Compose Build
**Steps:**
1. Run `docker compose -f docker-compose.local.yml build`
2. Verify both app and terminal-proxy images build successfully
3. Run `docker compose -f docker-compose.local.yml up -d`
4. Verify all services start (app on 3000, terminal-proxy on 3001, postgres on 5432, redis on 6379)
5. Run `docker compose -f docker-compose.local.yml down`

**Expected:** Local compose builds from source and all services start correctly.

### TC5: Dev Compose Unchanged
**Steps:**
1. Run `git diff HEAD~1 docker-compose.dev.yml`
2. Verify no changes to dev compose
3. Run `docker compose -f docker-compose.dev.yml config -q`
4. Verify validates cleanly

**Expected:** Dev compose is byte-identical to before S02, still validates.

### TC6: Terminal-Proxy Build Context
**Steps:**
1. Open `docker-compose.local.yml`
2. Verify terminal-proxy build context is `.` (repo root)
3. Verify terminal-proxy dockerfile is `services/terminal-proxy/Dockerfile`
4. Run `docker compose -f docker-compose.local.yml build terminal-proxy`
5. Verify pnpm workspace resolution works from repo root context

**Expected:** Terminal-proxy builds correctly with repo root context for pnpm workspace deploy.

## Edge Cases

### EC1: Standalone Output Contains Only Required Dependencies
1. Build the app image
2. Run `docker run --rm hive-app-test du -sh /app/`
3. Compare size to previous full-copy approach (should be significantly smaller)

### EC2: Non-Root User Cannot Write to System Directories
1. Run `docker run --rm hive-app-test touch /etc/test-write` 
2. Verify permission denied error (non-root user enforced)
