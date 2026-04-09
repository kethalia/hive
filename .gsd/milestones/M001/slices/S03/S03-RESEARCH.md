# S03: Blueprint Execution & Worker Agent — Research

**Date:** 2026-03-19
**Depth:** Deep research — novel architecture (blueprint runner), risky integration (orchestrator→workspace remote exec), multiple viable approaches for agent execution

## Summary

S03 builds the blueprint execution engine and connects the orchestrator to worker workspaces so that submitting a task causes a GSD/Pi agent to run autonomously inside a Coder workspace, producing code changes. This is the architectural backbone of Hive (R025) and the highest-risk slice because it introduces: (1) a blueprint runner that sequences deterministic and agent steps, (2) remote command execution from the orchestrator into Coder workspaces, (3) context hydration before agent execution (R027), (4) scoped rule injection (R026), and (5) curated tool selection (R030).

The primary execution mechanism is `coder ssh <workspace> -- <command>` (shelled out via `child_process.execFile`). The Coder CLI is already installed in the orchestrator's container and supports running commands on workspaces. The agent itself runs via Pi's `--print` mode (`pi -p "prompt"`) which is non-interactive and exits after completion — ideal for headless execution. The blueprint runner is plain TypeScript functions (not a DSL), where each step is an async function that receives a context object and can shell into the workspace.

The current BullMQ worker in `task-queue.ts` only creates the workspace and records it. S03 extends this worker to: wait for workspace build completion, run the blueprint steps sequentially, and update task status based on outcomes.

## Recommendation

**Approach: Shell-based remote execution via `coder ssh`**

Use `child_process.execFile("coder", ["ssh", workspaceName, "--", command])` from the orchestrator to run commands inside workspaces. This is simpler and more robust than SSH libraries (no key management, leverages existing Coder auth), and avoids the Coder Tasks API which is too opinionated for custom blueprint execution. The Coder CLI is already available and authenticated.

**Blueprint runner: Sequential async functions, not a generic engine**

Each blueprint step is a standalone async function: `hydrate → rules → agent → done`. The runner simply calls them in order, catching errors and updating status. No step registry, no plugin system, no DAG — just a typed array of step functions. This follows R025's explicit guidance: "TypeScript functions, not a generic engine."

**Agent execution: Pi print mode**

Run `pi -p --no-session --provider anthropic --model claude-sonnet-4-20250514 "prompt"` inside the workspace via `coder ssh`. The `--print` flag makes Pi non-interactive (R003). The `--no-session` flag avoids session file accumulation. Context is injected via the prompt itself (assembled from hydration), plus AGENTS.md files already in the repo.

## Implementation Landscape

### Key Files

**Existing (to modify):**
- `src/lib/queue/task-queue.ts` — Current worker creates workspace only. Must be extended to wait for build, then call the blueprint runner
- `src/lib/coder/client.ts` — Needs `getWorkspaceAgent()` method to resolve workspace name for SSH, and potentially `getWorkspaceResources()` to find the agent
- `src/lib/coder/types.ts` — Needs workspace agent type definitions (agent ID, name, status)

**New files to create:**
- `src/lib/blueprint/runner.ts` — Blueprint runner: takes a task + workspace context, runs steps in sequence, returns result. Core type: `BlueprintStep = (ctx: BlueprintContext) => Promise<StepResult>`
- `src/lib/blueprint/types.ts` — Shared types: `BlueprintContext` (taskId, workspaceName, repoUrl, prompt, branchName, assembledContext), `StepResult` (success/failure/skip + message), `BlueprintResult`
- `src/lib/blueprint/steps/hydrate.ts` — Context hydration step (R027): fetches relevant files from the repo (tree listing via `coder ssh`, `find` + `cat` for key files like README, package.json, AGENTS.md, relevant source files). Assembles into a context string
- `src/lib/blueprint/steps/rules.ts` — Scoped rule injection (R026): reads AGENTS.md from repo root and relevant subdirectories inside the workspace, appends to the agent prompt
- `src/lib/blueprint/steps/tools.ts` — Tool selection (R030): determines which Pi tools/extensions to enable based on repo type (Node.js project → read,bash,edit,write; web app → add browser; etc.). Returns CLI flags
- `src/lib/blueprint/steps/agent.ts` — Agent execution step (R003): runs `pi -p` via `coder ssh` with assembled context + rules + tool flags. Captures stdout/stderr. Detects success/failure from exit code
- `src/lib/workspace/exec.ts` — Wrapper around `coder ssh <workspace> -- <command>`. Returns `{stdout, stderr, exitCode}`. Handles timeouts. This is the single integration point for all remote execution

**Test files:**
- `src/__tests__/lib/blueprint/runner.test.ts` — Runner sequencing, error handling, step skip logic
- `src/__tests__/lib/blueprint/steps/hydrate.test.ts` — Context assembly
- `src/__tests__/lib/blueprint/steps/agent.test.ts` — Agent execution with mocked exec
- `src/__tests__/lib/workspace/exec.test.ts` — Exec wrapper with mocked child_process

### Build Order

1. **`workspace/exec.ts` first** — This is the foundational primitive. Everything else depends on being able to run commands inside workspaces. Build it, test it with mocked `child_process.execFile`. This unblocks all blueprint steps.

2. **`blueprint/types.ts` + `blueprint/runner.ts` second** — Define the step interface and runner. Test with dummy steps (no real workspace needed). This proves the sequencing and error handling.

3. **`blueprint/steps/hydrate.ts` third** — Context hydration is the highest-ROI step per R027. Uses `exec.ts` to run `find`, `cat`, etc. inside the workspace. Mock exec for tests.

4. **`blueprint/steps/rules.ts` + `blueprint/steps/tools.ts` fourth** — Simpler steps. Rules reads AGENTS.md files. Tools maps repo type to tool flags. Both use exec.ts.

5. **`blueprint/steps/agent.ts` fifth** — The actual Pi invocation. Depends on hydrate output and tool selection. Mock exec for unit tests.

6. **Wire into `task-queue.ts` last** — Extend the BullMQ worker to call `waitForBuild()` then `runBlueprint()`. This is integration — connect existing pieces.

### Verification Approach

- **Unit tests**: Each step function tested in isolation with mocked `exec`. Runner tested with mock steps. Target: all step functions have tests for success, failure, and edge cases.
- **Integration check**: `coder ssh <workspace> -- echo hello` from the orchestrator container confirms the exec path works. This validates the remote execution primitive against a real Coder instance.
- **End-to-end proof**: Submit a task via POST /api/tasks → workspace creates → blueprint runs → workspace contains code changes. Verify by `coder ssh <workspace> -- git diff` showing modifications. This is the slice's definition of done.
- **Headless Pi validation**: Run `coder ssh <workspace> -- pi -p --no-session "create a file called test.txt with hello world"` and verify the file exists. Proves R003 (non-interactive GSD execution).

## Constraints

- `coder` CLI must be available in the orchestrator container's PATH and logged in (`coder login`). The Docker Compose setup needs to mount/configure Coder credentials.
- Pi's `--print` mode reads piped stdin and merges it into the prompt. For large context payloads, pipe the assembled context via stdin rather than passing as a CLI argument (shell argument length limits).
- The orchestrator container runs inside Docker-in-Docker. `coder ssh` uses Coder's tunnel (DERP relay), not direct network — so it works regardless of network topology. No special networking config needed.
- Workspace build time is variable (2-5 minutes for first build, faster with prebuilds from S07). The BullMQ worker must handle long-running jobs — set appropriate timeouts and use `waitForBuild()` with the existing exponential backoff.

## Common Pitfalls

- **`coder ssh` requires workspace to be fully running** — calling it before the build completes or agent starts will fail. Must use `waitForBuild(id, "running")` and then verify the agent is connected before executing commands.
- **Pi print mode needs `bash -l` login shell** — tools installed via `nvm`, `pnpm`, etc. are only on PATH in a login shell. Use `coder ssh <workspace> -- bash -l -c 'pi -p ...'` to ensure the full environment is loaded.
- **Large prompts hit argument length limits** — piping context via stdin to `pi -p` is safer than passing as a CLI argument. `echo "<context>" | coder ssh <workspace> -- pi -p "implement the task"` or write a temp file inside the workspace.
- **BullMQ job timeout** — Default BullMQ job timeout is infinite, but the worker process could be killed. Set explicit `attempts: 1` and a generous `timeout` (30 min) on job options. Blueprint steps should have their own per-step timeouts.
- **Exit code from `coder ssh`** — When the remote command fails, `coder ssh` returns the remote exit code. Pi returns 0 on success, non-zero on error. Must check exit codes at each step.

## Open Risks

- **Context hydration quality is iterative** — The first version of hydrate.ts will be basic (repo tree + key files). Actual agent success rate depends on how well we select relevant files. This improves over time with feedback from real tasks. Don't over-engineer V1.
- **Pi stdout parsing** — In `--print` mode, Pi outputs the assistant's response to stdout. Tool calls and their output also appear. We need to determine whether the task succeeded by inspecting exit code and/or checking `git status` in the workspace afterwards, not by parsing Pi's output.
- **Long-running agent execution** — A complex task could run Pi for 15-30 minutes. The `coder ssh` process must stay alive for the duration. Need to verify there's no idle timeout on the SSH tunnel.
- **Coder CLI auth in Docker** — The orchestrator container needs `CODER_URL` and `CODER_SESSION_TOKEN` env vars for `coder ssh` to work. These must be injected via docker-compose environment, same as the existing CoderClient config.

## Skills Discovered

No directly relevant professional skills found for this slice's specific technologies (Coder workspace orchestration, Pi headless execution). The work is primarily TypeScript integration code using `child_process` and the existing codebase patterns.

## Sources

- Pi supports four modes: interactive, print/JSON, RPC, and SDK. Print mode (`-p`) is non-interactive and exits after completion (source: [Pi npm](https://www.npmjs.com/package/@mariozechner/pi-coding-agent))
- Pi RPC mode enables headless operation via JSON on stdin/stdout (source: [DeepWiki RPC Mode](https://deepwiki.com/badlogic/pi-mono/4.5-rpc-mode))
- Coder Tasks API (experimental, now GA in v2.29) supports programmatic task lifecycle (source: [Coder Blog](https://coder.com/blog/automate-coder-tasks-via-cli-and-api))
- `coder ssh <workspace> -- <command>` executes commands remotely on workspaces via Coder's tunnel
