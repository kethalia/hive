# S01 User Acceptance Test (UAT)

**Test Execution Date:** First execution on PR/merge to main  
**Environment:** GitHub Actions (Ubuntu runner), Docker 24.x+  
**Image Under Test:** `ghcr.io/kethalia/hive-base:latest` (after publish) or local `hive-base:local` (build phase)

---

## Preconditions

1. Repository has been pushed to GitHub with:
   - `docker/hive-base/Dockerfile` present and valid
   - `.github/workflows/build-base-image.yml` present and valid
2. GitHub Actions is enabled in repository settings
3. GitHub org is `kethalia` (or PAT has write:packages scope for GHCR)
4. Docker daemon is available in runner environment
5. Internet connectivity to download tooling (Docker, NodeSource, GitHub releases, obsidian.md)

---

## Test Suite

### Test Group 1: Dockerfile Static Validation

**Objective:** Verify the Dockerfile is syntactically correct and contains all required layers.

#### T1.1 — File exists and is readable
**Steps:**
1. Check that `docker/hive-base/Dockerfile` exists
2. Confirm file size > 100 lines (non-trivial content)

**Expected:** File exists, >100 lines

**Pass Criteria:** ✅ File is readable and substantial

---

#### T1.2 — Dockerfile syntax is valid
**Steps:**
1. Run `docker build --dry-run docker/hive-base/` (or parse with hadolint)
2. Check for parse errors, invalid instructions, unknown FROM tag

**Expected:** No syntax errors, FROM is recognized

**Pass Criteria:** ✅ Dockerfile passes linting; no fatal syntax errors

---

#### T1.3 — All required layers are present (grep validation)
**Steps:**
1. Grep Dockerfile for `FROM debian:trixie`
2. Grep Dockerfile for `openbox`
3. Grep Dockerfile for `ssl-cert` in useradd line
4. Grep Dockerfile for `claude.ai/install.sh`
5. Grep Dockerfile for `notesmd-cli`
6. Grep Dockerfile for `act` (binary or wget)
7. Grep Dockerfile for `google-chrome-stable` or similar
8. Grep Dockerfile for `nodejs` or `node` (NodeSource)
9. Grep Dockerfile for `kasmvncserver_trixie`
10. Confirm `fluxbox` is NOT present (negative grep)
11. Confirm `postgresql-16` version pin is NOT present (using unversioned `postgresql` instead)

**Expected:** All grepped items found, fluxbox absent, pg-16 absent

**Pass Criteria:** ✅ All 11 patterns match/mismatch as expected

---

### Test Group 2: Docker Build Execution

**Objective:** Verify the image builds without errors and all dependencies are satisfied.

#### T2.1 — Image builds successfully
**Steps:**
1. Run `docker build -t hive-base:local docker/hive-base/`
2. Monitor build output for errors, failed downloads, dependency conflicts
3. Verify build completes without `Step X FAILED` messages
4. Check final image layer hash is generated

**Expected:** Build completes, no errors, image tag `hive-base:local` is created

**Pass Criteria:** ✅ `docker images | grep hive-base:local` shows image with size >1GB

**Timeout:** 30 minutes (first build, all layers from scratch)

---

#### T2.2 — Build layer cache is efficient
**Steps:**
1. Run `docker build -t hive-base:v2 docker/hive-base/` a second time
2. Observe layer cache hits vs misses in build output
3. Confirm stable layers (FROM, Docker CE, Chrome) use cache

**Expected:** Second build is faster (~5-10 min); most base layers show "Using cache"

**Pass Criteria:** ✅ Build time is <50% of first run

**Optional (PR only):** N/A, cache is managed by GitHub Actions

---

### Test Group 3: Binary & Tool Presence (Smoke Tests)

**Objective:** Verify all required binaries are installed and callable inside the image.

#### T3.1 — Claude CLI is installed and functional
**Steps:**
1. Run `docker run --rm hive-base:local claude --version`
2. Check exit code is 0
3. Capture version string in stdout

**Expected:** Exit code 0, stdout contains semantic version (e.g., "claude 1.x.x" or similar)

**Pass Criteria:** ✅ `claude --version` exits 0

---

#### T3.2 — notesmd-cli is installed and functional
**Steps:**
1. Run `docker run --rm hive-base:local notesmd-cli --version`
2. Check exit code is 0
3. Capture version string

**Expected:** Exit code 0, stdout contains semantic version (e.g., "0.3.4")

**Pass Criteria:** ✅ `notesmd-cli --version` exits 0

---

#### T3.3 — act (GitHub Actions runner) is installed
**Steps:**
1. Run `docker run --rm hive-base:local act --version`
2. Check exit code is 0
3. Capture version string

**Expected:** Exit code 0, stdout contains version (e.g., "act version x.y.z")

**Pass Criteria:** ✅ `act --version` exits 0

---

#### T3.4 — VNC server binary exists
**Steps:**
1. Run `docker run --rm hive-base:local which vncserver`
2. Check exit code is 0
3. Capture path to vncserver binary

**Expected:** Exit code 0, stdout is absolute path (e.g., "/usr/bin/vncserver")

**Pass Criteria:** ✅ `which vncserver` exits 0

---

#### T3.5 — Openbox window manager is installed
**Steps:**
1. Run `docker run --rm hive-base:local which openbox`
2. Check exit code is 0
3. Capture path to openbox binary

**Expected:** Exit code 0, stdout is absolute path (e.g., "/usr/bin/openbox")

**Pass Criteria:** ✅ `which openbox` exits 0

---

#### T3.6 — Fluxbox is NOT installed (negative test)
**Steps:**
1. Run `docker run --rm hive-base:local which fluxbox`
2. Check exit code is non-zero (1 = not found)

**Expected:** Exit code 1, stderr empty or "not found"

**Pass Criteria:** ✅ `which fluxbox` exits 1 (command not found)

---

#### T3.7 — Node.js 24 is installed
**Steps:**
1. Run `docker run --rm hive-base:local node --version`
2. Check exit code is 0
3. Verify version string starts with "v24."

**Expected:** Exit code 0, version is v24.x.x

**Pass Criteria:** ✅ Node.js version is 24.x

---

#### T3.8 — Google Chrome is installed
**Steps:**
1. Run `docker run --rm hive-base:local google-chrome --version` OR `/opt/google/chrome/chrome --version`
2. Check exit code is 0
3. Capture version string

**Expected:** Exit code 0, version string present (e.g., "Google Chrome 124.0.xxxxx")

**Pass Criteria:** ✅ Chrome binary is callable and returns version

---

#### T3.9 — PostgreSQL client (psql) is available
**Steps:**
1. Run `docker run --rm hive-base:local psql --version`
2. Check exit code is 0
3. Verify version is PostgreSQL 17.x (trixie native)

**Expected:** Exit code 0, version shows PostgreSQL 17+

**Pass Criteria:** ✅ psql is available and version is 17.x

---

#### T3.10 — Docker CLI is available inside image
**Steps:**
1. Run `docker run --rm hive-base:local docker --version`
2. Check exit code is 0
3. Capture version

**Expected:** Exit code 0, version string present

**Pass Criteria:** ✅ docker binary is on PATH and callable

---

#### T3.11 — coder user exists and is in required groups
**Steps:**
1. Run `docker run --rm hive-base:local id coder`
2. Parse output for group memberships
3. Verify `docker` group is present
4. Verify `ssl-cert` group is present

**Expected:** Exit code 0, output includes "groups=..." with both `docker` and `ssl-cert`

**Pass Criteria:** ✅ coder user is in docker,ssl-cert groups

---

#### T3.12 — Obsidian is installed
**Steps:**
1. Run `docker run --rm hive-base:local which obsidian`
2. Check exit code is 0

**Expected:** Exit code 0, path to obsidian binary

**Pass Criteria:** ✅ `which obsidian` exits 0

---

#### T3.13 — Obsidian config includes CLI flag
**Steps:**
1. Run `docker run --rm hive-base:local cat ~/.config/obsidian/obsidian.json`
2. Verify JSON contains `{"cli": true}` or similar

**Expected:** Exit code 0, JSON parses correctly, contains cli setting

**Pass Criteria:** ✅ Config file exists with CLI enabled

---

### Test Group 4: GitHub Actions Workflow Validation

**Objective:** Verify the CI workflow is syntactically valid and has correct trigger/permissions.

#### T4.1 — Workflow file exists and is valid YAML
**Steps:**
1. Check that `.github/workflows/build-base-image.yml` exists
2. Run `python3 -c "import yaml; yaml.safe_load(open('.github/workflows/build-base-image.yml'))"`
3. Check exit code is 0 (no YAML parse errors)

**Expected:** File exists, parses as valid YAML

**Pass Criteria:** ✅ Workflow file is valid YAML

---

#### T4.2 — Workflow has correct triggers
**Steps:**
1. Grep workflow for `on:` section
2. Verify `push:` trigger exists with `main` branch or path filter
3. Verify `pull_request:` trigger exists
4. Verify `workflow_dispatch:` exists (manual trigger)

**Expected:** All three triggers present in YAML

**Pass Criteria:** ✅ Workflow responds to push/PR/manual dispatch

---

#### T4.3 — Workflow includes GHCR credentials
**Steps:**
1. Grep for `docker/login-action`
2. Verify `registry: ghcr.io` is set
3. Verify `username` and `password` use GitHub context/secrets

**Expected:** Login action present with GHCR registry

**Pass Criteria:** ✅ Workflow authenticates to GHCR

---

#### T4.4 — Workflow has correct permissions
**Steps:**
1. Grep for `permissions:` section
2. Verify `contents: read` is set (for checkout)
3. Verify `packages: write` is set (for GHCR push)

**Expected:** Both permissions present

**Pass Criteria:** ✅ Permissions are properly scoped

---

#### T4.5 — Workflow uses docker/build-push-action
**Steps:**
1. Grep for `docker/build-push-action`
2. Verify version is v6 or compatible
3. Confirm `context: docker/hive-base` is set
4. Confirm `push:` is conditional on branch

**Expected:** Action present, context correct, push is gated

**Pass Criteria:** ✅ Build-push-action is correctly configured

---

#### T4.6 — Workflow includes all 5 smoke tests
**Steps:**
1. Grep for `claude --version`
2. Grep for `notesmd-cli --version`
3. Grep for `act --version`
4. Grep for `which vncserver`
5. Grep for `which openbox`

**Expected:** All 5 smoke test commands present

**Pass Criteria:** ✅ Smoke test suite is complete

---

#### T4.7 — Workflow publishes with dual tags (:latest + :sha)
**Steps:**
1. Grep for `tags:` section in build-push-action
2. Verify `ghcr.io/kethalia/hive-base:latest` is present
3. Verify `ghcr.io/kethalia/hive-base:${{ github.sha }}` (or similar sha tag) is present

**Expected:** Both tags in the tag list

**Pass Criteria:** ✅ Image is published with :latest and :sha tags

---

#### T4.8 — Workflow skips GHCR push on PRs
**Steps:**
1. Find the build job configuration
2. Verify `push: ${{ github.ref == 'refs/heads/main' }}` (or similar conditional)
3. Confirm PRs have `push: false` or use a conditional that evaluates to false

**Expected:** Push only happens on main branch, not on PRs

**Pass Criteria:** ✅ GHCR push is gated to main branch only

---

### Test Group 5: End-to-End CI Workflow Execution

**Objective:** Verify the workflow runs successfully when triggered.

#### T5.1 — Workflow runs on push to main
**Steps:**
1. Push a commit to main branch with changes to `docker/hive-base/**`
2. Navigate to GitHub Actions tab in repository
3. Observe workflow run appears in the list
4. Wait for workflow to complete
5. Check final status is "passed"

**Expected:** Workflow appears, runs, completes successfully

**Pass Criteria:** ✅ GitHub Actions shows green checkmark for build-base-image workflow

**Note:** This test can only run after repository is pushed to GitHub with proper branch protection.

---

#### T5.2 — Workflow runs on PR to main
**Steps:**
1. Create a feature branch from main
2. Make a change to `docker/hive-base/Dockerfile`
3. Push feature branch and open PR against main
4. Navigate to GitHub Actions checks in PR
5. Wait for build-base-image workflow to run

**Expected:** Workflow runs automatically, builds image locally (no push), runs smoke tests

**Pass Criteria:** ✅ PR shows "All checks passed" or workflow shows green checkmark

---

#### T5.3 — Image is published to GHCR after merge
**Steps:**
1. Merge PR to main (or push directly)
2. Wait for build-base-image workflow to complete
3. Run `docker pull ghcr.io/kethalia/hive-base:latest` from local machine or CI runner
4. Verify image pulls successfully (exit 0)

**Expected:** Image exists in GHCR and is pullable

**Pass Criteria:** ✅ `docker pull ghcr.io/kethalia/hive-base:latest` succeeds

---

#### T5.4 — Smoke tests pass in workflow
**Steps:**
1. Review workflow run logs in GitHub Actions UI
2. Navigate to smoke-test job
3. Expand each smoke test step (claude, notesmd-cli, act, vncserver, openbox)
4. Verify each step shows "exit code 0" in logs

**Expected:** All 5 smoke tests pass (exit 0)

**Pass Criteria:** ✅ Workflow logs show "✓" or "exit 0" for all smoke tests

---

### Test Group 6: Integration Readiness (Cross-Check)

**Objective:** Verify the image is ready for S02 (Template Migration) to extend it.

#### T6.1 — Image can be extended (FROM child Dockerfile)
**Steps:**
1. Create a test Dockerfile with `FROM ghcr.io/kethalia/hive-base:latest`
2. Add a simple RUN layer (e.g., `RUN echo "child image"`)
3. Build: `docker build -t test-child:local .`
4. Verify build succeeds

**Expected:** Child image builds without error

**Pass Criteria:** ✅ `test-child:local` image is created

**Note:** This test validates that base image is correctly published and is usable as a build base.

---

#### T6.2 — All tools are callable from child image
**Steps:**
1. Run child image from T6.1 with smoke tests:
   - `docker run --rm test-child:local claude --version`
   - `docker run --rm test-child:local notesmd-cli --version`
   - `docker run --rm test-child:local act --version`
2. Verify all tools still work (exit 0)

**Expected:** All tools inherited by child, all callable

**Pass Criteria:** ✅ All 3 smoke tests pass in child image

---

#### T6.3 — coder user in child image retains group membership
**Steps:**
1. Run `docker run --rm test-child:local id coder` in child image
2. Verify docker and ssl-cert groups are present

**Expected:** Group membership inherited

**Pass Criteria:** ✅ coder user in docker,ssl-cert groups in child

---

### Test Group 7: Edge Cases & Negative Tests

**Objective:** Verify failure modes are handled gracefully.

#### T7.1 — Image fails gracefully if tool is missing
**Steps:**
1. Create a test Dockerfile that removes notesmd-cli: `RUN rm /usr/local/bin/notesmd-cli`
2. Try to run `docker run test-broken:local notesmd-cli --version`
3. Verify exit code is non-zero and stderr shows "command not found"

**Expected:** Graceful error message, exit code 127

**Pass Criteria:** ✅ Missing tool produces clear error (not silent failure)

---

#### T7.2 — Obsidian CLI mode respects config
**Steps:**
1. Run `docker run --rm hive-base:local obsidian --help` (assuming obsidian has --help)
2. Verify config from ~/.config/obsidian/obsidian.json is loaded (if obsidian respects it)

**Expected:** Obsidian CLI mode is functional per config

**Pass Criteria:** ✅ Obsidian respects headless config or starts in CLI mode

---

#### T7.3 — VNC server can be started
**Steps:**
1. Run `docker run --rm hive-base:local vncserver :99 -geometry 1024x768` (timeout after 3s)
2. Check that vncserver process starts (may fail if no X11, but should not error about missing binary)

**Expected:** VNC server starts or fails gracefully (missing X11 is OK)

**Pass Criteria:** ✅ vncserver binary executes (X11 availability is outside scope)

---

### Test Group 8: Documentation & Handoff

**Objective:** Verify artifact documentation is complete.

#### T8.1 — Dockerfile has comments explaining each layer
**Steps:**
1. Read docker/hive-base/Dockerfile
2. Verify each major layer (Claude, Obsidian, notesmd-cli, act, VNC) has a comment

**Expected:** Code is self-documenting; future maintainers understand purpose of each layer

**Pass Criteria:** ✅ Each tool layer has a preceding comment

---

#### T8.2 — Workflow has comments explaining triggers and jobs
**Steps:**
1. Read .github/workflows/build-base-image.yml
2. Verify build and smoke-test jobs are explained
3. Verify trigger conditions are clear (main vs PR behavior)

**Expected:** Workflow intent is documented

**Pass Criteria:** ✅ Workflow has explanatory comments

---

---

## Summary

**Total Test Cases:** 39 (grouped into 8 test groups)

**Critical Path (must all pass):**
- T1.1 — File exists
- T2.1 — Image builds
- T3.1 to T3.5 — Core tool smoke tests
- T4.1 to T4.8 — Workflow validation
- T5.1 or T5.2 — Workflow executes

**Optional (nice-to-have):**
- T5.3, T5.4 — Full CI integration (requires GitHub push)
- T6.1 to T6.3 — S02 handoff validation
- T7.1 to T7.3 — Edge cases
- T8.1, T8.2 — Documentation

**Pass/Fail Criteria:** All critical path tests must pass (exit code 0 for binaries, valid YAML for workflows, file existence checks). Optional tests provide confidence but are not blockers for S02.

**Next Steps After UAT:**
1. All tests pass → Slice S01 is complete, ready for merge
2. PR approved → Workflow publishes image to GHCR
3. S02 begins → Templates extended to use `FROM ghcr.io/kethalia/hive-base:latest`
