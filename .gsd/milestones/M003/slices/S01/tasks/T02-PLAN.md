---
estimated_steps: 23
estimated_files: 1
skills_used: []
---

# T02: Write GitHub Actions workflow to build and push hive-base image to GHCR

Create `.github/workflows/build-base-image.yml` that builds `docker/hive-base/Dockerfile`, runs smoke tests, and pushes to `ghcr.io/kethalia/hive-base:latest` on merge to main.

## Steps

1. Create `.github/workflows/build-base-image.yml` with trigger on push to `main` (paths: `docker/hive-base/**`) and `workflow_dispatch` for manual runs.
2. Add permissions: `contents: read`, `packages: write` (required for GHCR push).
3. Use standard Docker build-push pattern:
   - `actions/checkout@v4`
   - `docker/login-action@v3` with `registry: ghcr.io`, `username: ${{ github.actor }}`, `password: ${{ secrets.GITHUB_TOKEN }}`
   - `docker/setup-buildx-action@v3`
   - `docker/build-push-action@v6` with `context: docker/hive-base`, `push: true` (only on main), `tags: ghcr.io/kethalia/hive-base:latest,ghcr.io/kethalia/hive-base:${{ github.sha }}`
4. Add a smoke-test job that runs after build:
   - `docker run --rm ghcr.io/kethalia/hive-base:${{ github.sha }} claude --version`
   - `docker run --rm ghcr.io/kethalia/hive-base:${{ github.sha }} notesmd-cli --version`
   - `docker run --rm ghcr.io/kethalia/hive-base:${{ github.sha }} act --version`
   - `docker run --rm ghcr.io/kethalia/hive-base:${{ github.sha }} which vncserver`
   - `docker run --rm ghcr.io/kethalia/hive-base:${{ github.sha }} which openbox`
5. For PRs: build only (no push), still run smoke tests against the local image.

## Must-Haves
- [ ] Triggers on push to main (path-filtered to docker/hive-base/**) and workflow_dispatch
- [ ] Also triggers on PRs touching docker/hive-base/** (build-only, no push)
- [ ] Uses docker/build-push-action with GHCR login
- [ ] Smoke tests verify claude, notesmd-cli, act, vncserver, and openbox
- [ ] Push only happens on main branch (not PRs)
- [ ] Tags with both :latest and :sha

## Inputs

- ``docker/hive-base/Dockerfile` — the Dockerfile to build (created in T01)`

## Expected Output

- ``.github/workflows/build-base-image.yml` — complete CI workflow for building, testing, and pushing the hive-base image`

## Verification

test -f .github/workflows/build-base-image.yml && python3 -c "import yaml; yaml.safe_load(open('.github/workflows/build-base-image.yml'))" && grep -q 'ghcr.io/kethalia/hive-base' .github/workflows/build-base-image.yml && grep -q 'build-push-action' .github/workflows/build-base-image.yml && grep -q 'packages: write' .github/workflows/build-base-image.yml
