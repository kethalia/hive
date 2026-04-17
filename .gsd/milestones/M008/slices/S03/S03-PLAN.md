# S03: CI & Release Workflows

**Goal:** PR CI builds both Docker images without pushing; merging a changeset to main opens a version PR; merging the version PR pushes tagged images to GHCR. Only changed packages trigger Docker builds.
**Demo:** PR CI builds both Docker images without pushing; merging a changeset to main opens a version PR; merging the version PR pushes tagged images to GHCR

## Must-Haves

- `.github/workflows/ci.yml` exists with PR-triggered Docker builds (push: false) for both images and a `ci-pass` gate job
- `.github/workflows/release.yml` exists with changesets/action creating version PRs and two conditional Docker build+push jobs gated on package version extraction
- `ci:release` script exists in root package.json
- Both workflows use pinned action versions (checkout@v4, setup-buildx@v3, login-action@v3, build-push-action@v6, changesets/action@v1)
- CI builds use `push: false, load: true`; release builds use `push: true`
- Docker image names match D033: `ghcr.io/kethalia/hive` and `ghcr.io/kethalia/hive-terminal-proxy`
- Release tags: `v{version}`, `sha-{sha}`, `latest`
- Terminal-proxy build context is repo root (`.`) with explicit dockerfile path per S02
- YAML files parse without errors
- Concurrency: CI cancel-in-progress true, release cancel-in-progress false

## Proof Level

- This slice proves: Not provided.

## Integration Closure

Not provided.

## Verification

- Not provided.

## Tasks

- [x] **T01: Create CI workflow with PR Docker builds and gate job** `est:25m`
  Create `.github/workflows/ci.yml` that triggers on PRs to main. It builds both Docker images (hive and hive-terminal-proxy) without pushing — verifying Dockerfiles aren't broken. Includes a changeset status check and a single `ci-pass` gate job for branch protection.

This fulfills R073 (PR CI builds both Docker images).

## Steps

1. Create `.github/workflows/ci.yml` with `on: pull_request: branches: [main]` trigger.
2. Add `permissions: contents: read, packages: read` (no write needed — no push).
3. Add concurrency group `ci-${{ github.ref }}` with `cancel-in-progress: true`.
4. Create `build-app` job:
   - `actions/checkout@v4`
   - `docker/setup-buildx-action@v3`
   - `docker/build-push-action@v6` with context `.`, file `Dockerfile`, `push: false`, `load: true`, tag `ghcr.io/kethalia/hive:ci-${{ github.sha }}`
   - `cache-from: type=gha`, `cache-to: type=gha,mode=max`
5. Create `build-terminal-proxy` job (parallel with build-app):
   - Same checkout + buildx setup
   - `docker/build-push-action@v6` with context `.`, file `services/terminal-proxy/Dockerfile`, `push: false`, `load: true`, tag `ghcr.io/kethalia/hive-terminal-proxy:ci-${{ github.sha }}`
   - Same GHA caching
6. Create `changeset-check` job:
   - Checkout, pnpm/action-setup@v4, actions/setup-node@v4 (node 22, cache pnpm)
   - `pnpm install --frozen-lockfile`
   - Run `pnpm changeset status --since=origin/main` to verify PR includes a changeset
7. Create `ci-pass` gate job:
   - `needs: [build-app, build-terminal-proxy, changeset-check]`
   - `if: always()`
   - Check all three job results, exit 1 if any failed

## Must-Haves

- Both Docker builds use `push: false` and `load: true`
- Terminal-proxy build context is `.` (repo root) with explicit `file: services/terminal-proxy/Dockerfile`
- Image tags use `ghcr.io/kethalia/` namespace per D033
- Action versions pinned: checkout@v4, setup-buildx@v3, build-push-action@v6, action-setup@v4, setup-node@v4
- `ci-pass` gate uses `if: always()` and checks all upstream results
- Concurrency cancels in-progress PR builds

## Verification

- `node -e "require('js-yaml').load(require('fs').readFileSync('.github/workflows/ci.yml','utf8')); console.log('valid yaml')"` exits 0
- `grep -q 'push: false' .github/workflows/ci.yml` exits 0
- `grep -q 'ghcr.io/kethalia/hive:' .github/workflows/ci.yml` exits 0
- `grep -q 'ghcr.io/kethalia/hive-terminal-proxy:' .github/workflows/ci.yml` exits 0
- `grep -q 'services/terminal-proxy/Dockerfile' .github/workflows/ci.yml` exits 0
- `grep -q 'ci-pass' .github/workflows/ci.yml` exits 0
- `grep -q 'cancel-in-progress: true' .github/workflows/ci.yml` exits 0
  - Files: `.github/workflows/ci.yml`
  - Verify: node -e "require('js-yaml').load(require('fs').readFileSync('.github/workflows/ci.yml','utf8')); console.log('valid yaml')" && grep -q 'push: false' .github/workflows/ci.yml && grep -q 'ghcr.io/kethalia/hive:' .github/workflows/ci.yml && grep -q 'ghcr.io/kethalia/hive-terminal-proxy:' .github/workflows/ci.yml && grep -q 'ci-pass' .github/workflows/ci.yml

- [x] **T02: Create release workflow with changesets/action and conditional Docker build+push** `est:35m`
  Create `.github/workflows/release.yml` that triggers on push to main. Uses `changesets/action@v1` to either create a version PR (when changesets exist) or detect published packages (after version PR merge). Two conditional Docker jobs build and push images only for packages whose versions were bumped. Add `ci:release` script to root package.json.

This fulfills R074 (merging changesets opens version PR), R075 (merging version PR triggers Docker build+push), R080 (images published to ghcr.io/kethalia/), and R081 (only changed packages trigger Docker builds).

## Steps

1. Add `ci:release` script to root `package.json`: `"ci:release": "changeset tag"`. This is the publish command for changesets/action — it creates git tags for versioned private packages without publishing to npm (per D034).
2. Create `.github/workflows/release.yml` with `on: push: branches: [main]` trigger.
3. Add concurrency group `release-${{ github.ref }}` with `cancel-in-progress: false` (never cancel a release in progress).
4. Create `release` job:
   - `permissions: contents: write, pull-requests: write, packages: write`
   - Checkout, pnpm/action-setup@v4, actions/setup-node@v4 (node 22, cache pnpm)
   - `pnpm install --frozen-lockfile`
   - `changesets/action@v1` with `commit: 'chore: version packages'`, `title: 'chore: version packages'`, `publish: pnpm ci:release`, `version: pnpm changeset version`
   - Set outputs: `published`, `publishedPackages`
   - Extract `orchestratorVersion`: `jq -r '.[] | select(.name == "hive-orchestrator") | .version'` from publishedPackages
   - Extract `terminalProxyVersion`: `jq -r '.[] | select(.name == "hive-terminal-proxy") | .version'` from publishedPackages
5. Create `docker-app` job:
   - `needs: [release]`
   - `if: needs.release.outputs.orchestratorVersion != ''` (R081 — only build when orchestrator version bumped)
   - `permissions: contents: read, packages: write`
   - Checkout, setup-buildx, GHCR login (actor + GITHUB_TOKEN)
   - Compute tags step: `ghcr.io/kethalia/hive:v{version}`, `ghcr.io/kethalia/hive:sha-{sha}`, `ghcr.io/kethalia/hive:latest`
   - `docker/build-push-action@v6` with context `.`, file `Dockerfile`, `push: true`, computed tags
   - OCI labels: source, description, version, revision, created
   - GHA cache
6. Create `docker-terminal-proxy` job:
   - Same pattern as docker-app but:
   - `if: needs.release.outputs.terminalProxyVersion != ''`
   - Image: `ghcr.io/kethalia/hive-terminal-proxy`
   - File: `services/terminal-proxy/Dockerfile`, context: `.` (repo root per S02)
   - Tags with terminal-proxy version

## Must-Haves

- `ci:release` script in package.json runs `changeset tag`
- changesets/action uses `pnpm ci:release` as publish command
- Version extraction uses correct package names: `hive-orchestrator` and `hive-terminal-proxy`
- Docker jobs are conditional on their respective package version being non-empty (R081)
- Image names match D033: `ghcr.io/kethalia/hive` and `ghcr.io/kethalia/hive-terminal-proxy`
- Tags include `v{version}`, `sha-{sha}`, and `latest`
- Terminal-proxy build context is `.` with explicit `file: services/terminal-proxy/Dockerfile`
- Concurrency does NOT cancel in-progress releases
- `permissions: packages: write` on Docker jobs for GHCR push
- Action versions pinned: checkout@v4, setup-buildx@v3, login-action@v3, build-push-action@v6, changesets/action@v1, action-setup@v4, setup-node@v4

## Verification

- `node -e "require('js-yaml').load(require('fs').readFileSync('.github/workflows/release.yml','utf8')); console.log('valid yaml')"` exits 0
- `grep -q 'changesets/action@v1' .github/workflows/release.yml` exits 0
- `grep -q 'hive-orchestrator' .github/workflows/release.yml` exits 0
- `grep -q 'hive-terminal-proxy' .github/workflows/release.yml` exits 0
- `grep -q 'push: true' .github/workflows/release.yml` exits 0
- `grep -q 'cancel-in-progress: false' .github/workflows/release.yml` exits 0
- `grep -q 'ghcr.io/kethalia/hive:' .github/workflows/release.yml` exits 0
- `grep -q 'ghcr.io/kethalia/hive-terminal-proxy:' .github/workflows/release.yml` exits 0
- `node -e "const p=require('./package.json'); if(!p.scripts['ci:release']) process.exit(1)"` exits 0
  - Files: `.github/workflows/release.yml`, `package.json`
  - Verify: node -e "require('js-yaml').load(require('fs').readFileSync('.github/workflows/release.yml','utf8')); console.log('valid yaml')" && grep -q 'changesets/action@v1' .github/workflows/release.yml && grep -q 'hive-orchestrator' .github/workflows/release.yml && grep -q 'hive-terminal-proxy' .github/workflows/release.yml && grep -q 'push: true' .github/workflows/release.yml && node -e "const p=require('./package.json'); if(!p.scripts['ci:release']) process.exit(1)"

## Files Likely Touched

- .github/workflows/ci.yml
- .github/workflows/release.yml
- package.json
