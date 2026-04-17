---
estimated_steps: 50
estimated_files: 2
skills_used: []
---

# T02: Create release workflow with changesets/action and conditional Docker build+push

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

## Inputs

- ``Dockerfile` — root Dockerfile from S02 for app image build`
- ``services/terminal-proxy/Dockerfile` — terminal-proxy Dockerfile from S02 for proxy image build`
- ``.changeset/config.json` — changesets configuration from S01 with independent versioning and private package support`
- ``package.json` — root package.json to add ci:release script`
- ``.github/workflows/ci.yml` — CI workflow from T01 for pattern consistency (action versions, buildx setup, caching)`

## Expected Output

- ``.github/workflows/release.yml` — Release workflow with changesets/action + two conditional Docker build+push jobs`
- ``package.json` — Updated with ci:release script for changeset tag`

## Verification

node -e "require('js-yaml').load(require('fs').readFileSync('.github/workflows/release.yml','utf8')); console.log('valid yaml')" && grep -q 'changesets/action@v1' .github/workflows/release.yml && grep -q 'hive-orchestrator' .github/workflows/release.yml && grep -q 'hive-terminal-proxy' .github/workflows/release.yml && grep -q 'push: true' .github/workflows/release.yml && node -e "const p=require('./package.json'); if(!p.scripts['ci:release']) process.exit(1)"
