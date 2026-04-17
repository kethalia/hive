---
estimated_steps: 38
estimated_files: 1
skills_used: []
---

# T01: Create CI workflow with PR Docker builds and gate job

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

## Inputs

- ``Dockerfile` — root Dockerfile created in S02, target for app image build`
- ``services/terminal-proxy/Dockerfile` — terminal-proxy Dockerfile created in S02, target for proxy image build`
- ``.github/workflows/build-base-image.yml` — reference for GHCR login, buildx, and build-push-action patterns`

## Expected Output

- ``.github/workflows/ci.yml` — CI workflow with PR Docker builds (no push) and ci-pass gate job`

## Verification

node -e "require('js-yaml').load(require('fs').readFileSync('.github/workflows/ci.yml','utf8')); console.log('valid yaml')" && grep -q 'push: false' .github/workflows/ci.yml && grep -q 'ghcr.io/kethalia/hive:' .github/workflows/ci.yml && grep -q 'ghcr.io/kethalia/hive-terminal-proxy:' .github/workflows/ci.yml && grep -q 'ci-pass' .github/workflows/ci.yml
