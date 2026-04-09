---
id: T04
parent: S01
milestone: M001
provides:
  - hive-worker Coder template with task parameter variables, Pi/GSD agent, GitHub auth, headless execution (no interactive IDE tools)
key_files:
  - hive-worker/main.tf
  - hive-worker/Dockerfile
  - hive-worker/scripts/init.sh
key_decisions:
  - Removed EXTENSIONS_GALLERY env var and merge() pattern from agent env block since no code-server is included
  - Branch checkout uses fallback (checkout -b || checkout) to handle both new and existing branches
patterns_established:
  - HIVE_* env vars injected via Terraform variables into coder_agent env block for task parameterization
observability_surfaces:
  - init.sh logs repo clone and branch checkout with echo statements for Coder workspace build logs
  - HIVE_TASK_ID, HIVE_TASK_PROMPT, HIVE_REPO_URL, HIVE_BRANCH_NAME available as env vars inside the workspace for agent inspection
duration: 8m
verification_result: passed
completed_at: 2026-03-19
blocker_discovered: false
---

# T04: Create hive-worker Coder template derived from ai-dev

**Created hive-worker/ Coder template with task parameter variables (task_id, task_prompt, repo_url, branch_name), Pi/GSD agent apps, GitHub auth, and headless execution — removed OpenCode, Claude Code, web3, code-server, and filebrowser.**

## What Happened

Copied ai-dev/Dockerfile and 9 scripts to hive-worker/, then created hive-worker/main.tf by deriving from ai-dev/main.tf with surgical changes: added 4 task parameter variables at the top, injected HIVE_* env vars into the coder_agent env block, removed all interactive IDE resources (OpenCode, Claude Code, code-server, filebrowser) and web3 tools, and kept Pi/GSD apps, GitHub external auth, all git modules, AI/CI/shell/node/browser tools, Docker resources, and metadata. Updated init.sh to clone HIVE_REPO_URL and checkout HIVE_BRANCH_NAME on workspace start with idempotency guards.

## Verification

All task-level verification checks passed:
- All 4 task variable declarations present (grep -c returns 1 each)
- All 4 HIVE_* env vars injected in agent env block
- Zero occurrences of opencode, tools_web3, claude_code, code-server, filebrowser
- Pi app and GSD app preserved (grep confirms)
- All 9 file()/templatefile() references resolve to existing scripts in hive-worker/scripts/
- init.sh contains HIVE_REPO_URL clone and HIVE_BRANCH_NAME checkout logic
- All 22 existing tests pass (4 test files)
- terraform validate skipped (CLI not available)

## Verification Evidence

| # | Command | Exit Code | Verdict | Duration |
|---|---------|-----------|---------|----------|
| 1 | `grep -c 'variable "task_id"' hive-worker/main.tf` | 0 | ✅ pass (returns 1) | <1s |
| 2 | `grep -c 'variable "task_prompt"' hive-worker/main.tf` | 0 | ✅ pass (returns 1) | <1s |
| 3 | `grep -c 'variable "repo_url"' hive-worker/main.tf` | 0 | ✅ pass (returns 1) | <1s |
| 4 | `grep -c 'variable "branch_name"' hive-worker/main.tf` | 0 | ✅ pass (returns 1) | <1s |
| 5 | `grep 'HIVE_TASK_ID' hive-worker/main.tf` | 0 | ✅ pass | <1s |
| 6 | `grep -ci 'opencode' hive-worker/main.tf` | 1 | ✅ pass (returns 0) | <1s |
| 7 | `grep -c 'tools_web3' hive-worker/main.tf` | 1 | ✅ pass (returns 0) | <1s |
| 8 | `grep -c 'claude_code' hive-worker/main.tf` | 1 | ✅ pass (returns 0) | <1s |
| 9 | `grep -c 'coder_app.*pi' hive-worker/main.tf` | 0 | ✅ pass (returns 1) | <1s |
| 10 | `file()/templatefile() reference check` | 0 | ✅ pass (all 9 scripts exist) | <1s |
| 11 | `npx vitest run` | 0 | ✅ pass (22 tests, 4 files) | 3.3s |

## Diagnostics

- **Template inspection:** `grep -c 'variable\|resource\|module\|coder_app\|coder_script' hive-worker/main.tf` shows resource counts
- **Script inventory:** `ls hive-worker/scripts/` lists all available scripts
- **Diff from source:** `diff ai-dev/main.tf hive-worker/main.tf` shows all changes from the base template
- **Init script review:** `grep -A5 'HIVE_REPO_URL' hive-worker/scripts/init.sh` shows repo clone logic
- **Env var injection:** `grep 'HIVE_' hive-worker/main.tf` shows all task parameter env vars

## Deviations

- Simplified the agent env block from `merge({...}, conditional)` to a flat map since the conditional ANTHROPIC_API_KEY (for Claude Code) was removed along with Claude Code itself.
- Added idempotency guard in init.sh repo clone (checks if /home/coder/project exists before cloning) and fallback checkout logic (tries -b for new branch, falls back to existing branch).

## Known Issues

- Terraform validate could not be run (terraform CLI not available in this environment). Template is manually verified for reference consistency.

## Files Created/Modified

- `hive-worker/main.tf` — Coder template with task parameter variables, Pi/GSD apps, GitHub auth, no interactive IDE tools
- `hive-worker/Dockerfile` — Copy of ai-dev/Dockerfile (Ubuntu 24.04 with Docker, Chrome, Node.js, build tools)
- `hive-worker/scripts/init.sh` — Modified to clone HIVE_REPO_URL and checkout HIVE_BRANCH_NAME on workspace start
- `hive-worker/scripts/tools-ai.sh` — Copy from ai-dev (Pi agent installation)
- `hive-worker/scripts/tools-ci.sh` — Copy from ai-dev (CI/CD tools with GitHub token)
- `hive-worker/scripts/tools-shell.sh` — Copy from ai-dev (zsh, starship, tmux)
- `hive-worker/scripts/tools-node.sh` — Copy from ai-dev (pnpm, yarn, bun)
- `hive-worker/scripts/tools-nvm.sh` — Copy from ai-dev (nvm with Node.js versions)
- `hive-worker/scripts/tools-browser.sh` — Copy from ai-dev (Chrome/Playwright)
- `hive-worker/scripts/browser-serve.sh` — Copy from ai-dev (noVNC browser server)
- `hive-worker/scripts/symlinks.sh` — Copy from ai-dev (tool symlinks)
