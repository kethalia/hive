# S02: S02: Template Migration — UAT

**Milestone:** M003
**Written:** 2026-04-09T16:09:19.027Z

# S02: Template Migration — UAT (User Acceptance Tests)

**Slice:** S02  
**Milestone:** M003  
**Test Date:** 2026-04-09  
**Status:** ✅ PASS  

---

## Preconditions

- Working directory: `/home/coder/coder` (project root)
- All S01 work is merged to `main` (hive-base:latest image exists in GHCR)
- All S02 task summaries show verification_result: passed
- Docker and Terraform are installed and functional
- Node.js and npm are available for vitest

---

## Test Case 1: Dockerfile Consolidation

**Goal:** Verify all four template Dockerfiles are minimal and reference only the shared base image.

### 1.1: Dockerfile line counts

**Test Steps:**
```bash
cd /home/coder/coder
wc -l templates/hive-worker/Dockerfile \
        templates/hive-verifier/Dockerfile \
        templates/hive-council/Dockerfile \
        templates/ai-dev/Dockerfile
```

**Expected Outcome:**
```
  1 templates/hive-worker/Dockerfile
  1 templates/hive-verifier/Dockerfile
  1 templates/hive-council/Dockerfile
  1 templates/ai-dev/Dockerfile
  4 total
```

**Actual Result:** ✅ PASS (all show 1 line)

---

### 1.2: Dockerfile content uniformity

**Test Steps:**
```bash
cd /home/coder/coder
for f in templates/{hive-worker,hive-verifier,hive-council,ai-dev}/Dockerfile; do
  echo "=== $f ==="
  cat "$f"
done
```

**Expected Outcome:**
All four files contain exactly:
```
FROM ghcr.io/kethalia/hive-base:latest
```

**Actual Result:** ✅ PASS (all four are identical single-line FROM statements)

---

### 1.3: No ubuntu:24.04 references

**Test Steps:**
```bash
cd /home/coder/coder
grep -r 'ubuntu:24.04' templates/{hive-worker,hive-verifier,hive-council,ai-dev}/Dockerfile
echo "Exit code: $?"
```

**Expected Outcome:**
Exit code 1 (grep found no matches)

**Actual Result:** ✅ PASS (exit code 1 — no ubuntu:24.04 found)

---

## Test Case 2: Window Manager Alignment (fluxbox → openbox)

**Goal:** Verify all browser-serve.sh scripts reference openbox (not fluxbox) with correct flags.

### 2.1: No fluxbox references

**Test Steps:**
```bash
cd /home/coder/coder
grep -r 'fluxbox' templates/{hive-worker,hive-verifier,hive-council,ai-dev}/scripts/browser-serve.sh 2>/dev/null
echo "Exit code: $?"
```

**Expected Outcome:**
Exit code 1 (grep found no matches)

**Actual Result:** ✅ PASS (exit code 1 — no fluxbox found)

---

### 2.2: openbox present in all browser-serve.sh files

**Test Steps:**
```bash
cd /home/coder/coder
echo "=== Checking openbox references ==="
for f in templates/{hive-worker,hive-verifier,ai-dev}/scripts/browser-serve.sh; do
  echo -n "$f: "
  grep -c 'openbox' "$f"
done
echo ""
echo "=== Checking hive-council browser-serve.sh ==="
test -x templates/hive-council/scripts/browser-serve.sh && echo "hive-council: executable" || echo "FAIL"
grep -c 'openbox' templates/hive-council/scripts/browser-serve.sh
```

**Expected Outcome:**
- hive-worker/scripts/browser-serve.sh: 2 occurrences (command check + nohup line)
- hive-verifier/scripts/browser-serve.sh: 2 occurrences
- ai-dev/scripts/browser-serve.sh: 2 occurrences
- hive-council/scripts/browser-serve.sh: executable, 2 occurrences

**Actual Result:** ✅ PASS (all show 2 occurrences, hive-council is executable)

---

### 2.3: openbox invocation syntax correct

**Test Steps:**
```bash
cd /home/coder/coder
echo "=== hive-worker openbox invocation (around line 63-65) ==="
sed -n '63,65p' templates/hive-worker/scripts/browser-serve.sh

echo ""
echo "=== hive-verifier openbox invocation ==="
sed -n '63,65p' templates/hive-verifier/scripts/browser-serve.sh

echo ""
echo "=== ai-dev openbox invocation ==="
sed -n '63,65p' templates/ai-dev/scripts/browser-serve.sh
```

**Expected Outcome:**
Each shows a pattern like:
```bash
if command -v openbox &>/dev/null; then
  nohup openbox --sm-disable --display ":${DISPLAY_NUM}" > "$LOG_DIR/openbox.log" 2>&1 &
  disown $!
```

**Actual Result:** ✅ PASS (all three scripts show correct openbox invocation with --sm-disable --display flags)

---

## Test Case 3: hive-council KasmVNC Wiring

**Goal:** Verify hive-council has the browser-serve.sh script and matching Terraform resources for KasmVNC integration.

### 3.1: browser-serve.sh present and executable

**Test Steps:**
```bash
cd /home/coder/coder
test -x templates/hive-council/scripts/browser-serve.sh && echo "PASS: executable" || echo "FAIL: not executable"
```

**Expected Outcome:**
PASS: executable

**Actual Result:** ✅ PASS

---

### 3.2: browser-serve.sh references openbox

**Test Steps:**
```bash
cd /home/coder/coder
grep -c 'openbox' templates/hive-council/scripts/browser-serve.sh
```

**Expected Outcome:**
2 (command check + nohup invocation)

**Actual Result:** ✅ PASS (2 occurrences)

---

### 3.3: hive-council main.tf has coder_script.browser_serve

**Test Steps:**
```bash
cd /home/coder/coder
grep -A 7 'resource "coder_script" "browser_serve"' templates/hive-council/main.tf
```

**Expected Outcome:**
```hcl
resource "coder_script" "browser_serve" {
  agent_id           = coder_agent.main.id
  display_name       = "Browser Vision Server"
  icon               = "/icon/terminal.svg"
  run_on_start       = true
  start_blocks_login = false
  script             = file("${path.module}/scripts/browser-serve.sh")
}
```

**Actual Result:** ✅ PASS (resource present with correct structure)

---

### 3.4: hive-council main.tf has coder_app.browser_vision

**Test Steps:**
```bash
cd /home/coder/coder
grep -A 7 'resource "coder_app" "browser_vision"' templates/hive-council/main.tf
```

**Expected Outcome:**
```hcl
resource "coder_app" "browser_vision" {
  agent_id     = coder_agent.main.id
  slug         = "browser-vision"
  display_name = "Browser"
  url          = "http://localhost:6080"
  icon         = "/icon/terminal.svg"
  subdomain    = true
  share        = "owner"
}
```

**Actual Result:** ✅ PASS (resource present with correct structure)

---

## Test Case 4: Terraform Validation

**Goal:** Verify all four templates pass terraform validate with no configuration errors.

### 4.1: hive-worker terraform validate

**Test Steps:**
```bash
cd /home/coder/coder/templates/hive-worker
terraform validate
```

**Expected Outcome:**
```
Success! The configuration is valid.
```

**Actual Result:** ✅ PASS

---

### 4.2: hive-verifier terraform validate

**Test Steps:**
```bash
cd /home/coder/coder/templates/hive-verifier
terraform validate
```

**Expected Outcome:**
```
Success! The configuration is valid.
```

**Actual Result:** ✅ PASS

---

### 4.3: hive-council terraform validate

**Test Steps:**
```bash
cd /home/coder/coder/templates/hive-council
terraform validate
```

**Expected Outcome:**
```
Success! The configuration is valid.
```

**Actual Result:** ✅ PASS

---

### 4.4: ai-dev terraform validate

**Test Steps:**
```bash
cd /home/coder/coder/templates/ai-dev
terraform init  # First run needs init
terraform validate
```

**Expected Outcome:**
```
Success! The configuration is valid.
```

**Actual Result:** ✅ PASS (terraform init succeeded, validate passed)

---

## Test Case 5: Regression Testing (vitest)

**Goal:** Verify the full test suite still passes (263 tests) — no regressions in orchestrator/blueprint logic.

### 5.1: vitest suite passes

**Test Steps:**
```bash
cd /home/coder/coder
npx vitest run
```

**Expected Outcome:**
```
Test Files  37 passed (37)
     Tests  263 passed (263)
```

**Actual Result:** ✅ PASS (263 tests passed, 37 files, ~2 seconds total)

---

### 5.2: No console errors or warnings

**Test Steps:**
```bash
cd /home/coder/coder
npx vitest run 2>&1 | grep -i 'error\|fail' | grep -v 'stderr'
echo "Exit code: $?"
```

**Expected Outcome:**
Exit code 1 (no matches for actual errors — stderr logging is expected and acceptable)

**Actual Result:** ✅ PASS (only normal stderr logging from tests, no actual failures)

---

## Edge Cases & Boundary Conditions

### E1: Dockerfile FROM image availability

**Assumption:** The image `ghcr.io/kethalia/hive-base:latest` exists and is accessible to the Docker daemon. This is guaranteed by S01 (published via GitHub Actions CI on merge to main).

**Test:** If a template build fails with "image not found", that indicates S01 did not publish successfully, not an S02 regression. S02 assumes S01 is complete.

**Result:** ✅ Not applicable (S01 verified, GHCR image is reachable)

---

### E2: Terraform state conflicts

**Assumption:** Each template directory has a .terraform/ directory with a cached lock file. Running `terraform init` multiple times is idempotent and safe.

**Test:** `terraform validate` passed for all four templates without state conflicts.

**Result:** ✅ PASS (no state conflicts observed)

---

### E3: openbox binary availability in base image

**Assumption:** The hive-base:latest image contains openbox binary at runtime (verified by S01 smoke tests). If openbox is missing, `if command -v openbox` will skip the window manager invocation, causing the VNC server to start but without a desktop environment.

**Test:** S01 verified `openbox --version` exits 0 inside the base image. S02 assumes this is still true.

**Result:** ✅ Assumption valid (S01 passed smoke tests)

---

## Summary

**Total Test Cases:** 14 main cases + 3 edge cases  
**Passed:** 14/14 (100%)  
**Failed:** 0  
**Status:** ✅ **READY FOR S03**

All slice verification requirements are met:
- ✅ All 4 Dockerfiles are 1 line (FROM hive-base only)
- ✅ No ubuntu:24.04 references
- ✅ All browser-serve.sh scripts use openbox (not fluxbox)
- ✅ hive-council has browser-serve.sh and Terraform wiring
- ✅ All 4 templates pass terraform validate
- ✅ All 263 vitest tests pass (no regressions)

The slice is complete and ready for downstream consumption by S03 (Obsidian & Vault Integration).
