---
estimated_steps: 25
estimated_files: 7
skills_used: []
---

# T01: Replace all 4 Dockerfiles with slim FROM-only files and fix fluxbox→openbox in browser-serve.sh

Replace all four 131-line ubuntu:24.04 Dockerfiles with minimal ~3-line files that just extend the shared base image. Also fix the window manager reference in all 3 existing browser-serve.sh scripts (fluxbox→openbox) since the base image ships openbox, not fluxbox.

## Steps

1. Replace `templates/hive-worker/Dockerfile` with:
   ```dockerfile
   FROM ghcr.io/kethalia/hive-base:latest
   ```
   (single line — no extra layers needed for S02)

2. Replace `templates/hive-verifier/Dockerfile` with the same single-line content.

3. Replace `templates/hive-council/Dockerfile` with the same single-line content.

4. Replace `templates/ai-dev/Dockerfile` with the same single-line content.

5. In `templates/hive-worker/scripts/browser-serve.sh`, change lines 63-64:
   - `if command -v fluxbox` → `if command -v openbox`
   - `nohup fluxbox -display ":${DISPLAY_NUM}" > "$LOG_DIR/fluxbox.log"` → `nohup openbox --sm-disable --display ":${DISPLAY_NUM}" > "$LOG_DIR/openbox.log"`
   Note: openbox uses `--sm-disable` flag to skip session management in containers, and `--display` not `-display`.

6. Apply the same fluxbox→openbox fix in `templates/hive-verifier/scripts/browser-serve.sh` (identical change).

7. Apply the same fluxbox→openbox fix in `templates/ai-dev/scripts/browser-serve.sh` (identical change).

## Must-Haves

- [ ] All 4 Dockerfiles are exactly 1 line: `FROM ghcr.io/kethalia/hive-base:latest`
- [ ] No Dockerfile references `ubuntu:24.04`
- [ ] All 3 browser-serve.sh files reference `openbox`, not `fluxbox`

## Verification

- `wc -l templates/*/Dockerfile` — each shows 1 line
- `grep -r 'ubuntu:24.04' templates/*/Dockerfile` — returns nothing
- `grep -r 'fluxbox' templates/*/scripts/browser-serve.sh` — returns nothing
- `grep -c 'openbox' templates/*/scripts/browser-serve.sh` — returns count > 0 for each

## Inputs

- `templates/hive-worker/Dockerfile`
- `templates/hive-verifier/Dockerfile`
- `templates/hive-council/Dockerfile`
- `templates/ai-dev/Dockerfile`
- `templates/hive-worker/scripts/browser-serve.sh`
- `templates/hive-verifier/scripts/browser-serve.sh`
- `templates/ai-dev/scripts/browser-serve.sh`

## Expected Output

- `templates/hive-worker/Dockerfile`
- `templates/hive-verifier/Dockerfile`
- `templates/hive-council/Dockerfile`
- `templates/ai-dev/Dockerfile`
- `templates/hive-worker/scripts/browser-serve.sh`
- `templates/hive-verifier/scripts/browser-serve.sh`
- `templates/ai-dev/scripts/browser-serve.sh`

## Verification

wc -l templates/*/Dockerfile && grep -r 'ubuntu:24.04' templates/*/Dockerfile; test $? -ne 0 && grep -r 'fluxbox' templates/*/scripts/browser-serve.sh; test $? -ne 0 && echo 'T01 PASS'
