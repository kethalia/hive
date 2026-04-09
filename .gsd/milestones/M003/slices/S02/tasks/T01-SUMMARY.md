---
id: T01
parent: S02
milestone: M003
key_files:
  - templates/hive-worker/Dockerfile
  - templates/hive-verifier/Dockerfile
  - templates/hive-council/Dockerfile
  - templates/ai-dev/Dockerfile
  - templates/hive-worker/scripts/browser-serve.sh
  - templates/hive-verifier/scripts/browser-serve.sh
  - templates/ai-dev/scripts/browser-serve.sh
key_decisions:
  - (none)
duration: 
verification_result: passed
completed_at: 2026-04-09T16:05:18.385Z
blocker_discovered: false
---

# T01: Replaced 4 verbose Dockerfiles with single-line FROM hive-base images and fixed fluxbox→openbox in all 3 browser-serve.sh scripts

**Replaced 4 verbose Dockerfiles with single-line FROM hive-base images and fixed fluxbox→openbox in all 3 browser-serve.sh scripts**

## What Happened

All four template Dockerfiles (hive-worker, hive-verifier, hive-council, ai-dev) were overwritten with a single `FROM ghcr.io/kethalia/hive-base:latest` line, eliminating ~130 lines of duplicated base setup per template. The three browser-serve.sh scripts had their window manager invocation updated from fluxbox to openbox with the correct --sm-disable --display flags required for headless container use.

## Verification

wc -l confirmed all 4 target Dockerfiles are 1 line. grep confirmed no ubuntu:24.04 in scope Dockerfiles. grep confirmed no fluxbox in any browser-serve.sh. grep -c confirmed 2 openbox occurrences in each of the 3 browser-serve.sh files.

## Verification Evidence

| # | Command | Exit Code | Verdict | Duration |
|---|---------|-----------|---------|----------|
| 1 | `wc -l templates/*/Dockerfile` | 0 | ✅ pass | 50ms |
| 2 | `grep -r 'ubuntu:24.04' templates/{hive-worker,hive-verifier,hive-council,ai-dev}/Dockerfile` | 1 | ✅ pass | 30ms |
| 3 | `grep -r 'fluxbox' templates/*/scripts/browser-serve.sh` | 1 | ✅ pass | 30ms |
| 4 | `grep -c 'openbox' templates/hive-worker/scripts/browser-serve.sh templates/hive-verifier/scripts/browser-serve.sh templates/ai-dev/scripts/browser-serve.sh` | 0 | ✅ pass | 30ms |

## Deviations

None.

## Known Issues

templates/web3-dev/Dockerfile still uses ubuntu:24.04 — out of scope for this task.

## Files Created/Modified

- `templates/hive-worker/Dockerfile`
- `templates/hive-verifier/Dockerfile`
- `templates/hive-council/Dockerfile`
- `templates/ai-dev/Dockerfile`
- `templates/hive-worker/scripts/browser-serve.sh`
- `templates/hive-verifier/scripts/browser-serve.sh`
- `templates/ai-dev/scripts/browser-serve.sh`
