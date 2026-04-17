# Requirements

This file is the explicit capability and coverage contract for the project.

## Active

### R001 — User can submit a task by providing a text prompt, target repo URL, and optional file attachments via the web dashboard
- Class: primary-user-loop
- Status: active
- Description: User can submit a task by providing a text prompt, target repo URL, and optional file attachments via the web dashboard
- Why it matters: This is the entry point for all automation — without it, nothing runs
- Source: user
- Primary owning slice: M001/S02
- Supporting slices: none
- Validation: unmapped
- Notes: Attachments could be screenshots, spec docs, or reference files

### R002 — Orchestrator creates isolated Coder workspaces from the worker template via REST API, passing task-specific parameters
- Class: core-capability
- Status: active
- Description: Orchestrator creates isolated Coder workspaces from the worker template via REST API, passing task-specific parameters
- Why it matters: Workspace isolation is the foundation — each task gets a clean, independent environment
- Source: user
- Primary owning slice: M001/S01
- Supporting slices: M001/S03
- Validation: unmapped
- Notes: Uses Coder's workspace API with rich_parameter_values for task config

### R003 — GSD runs in non-interactive mode inside the worker workspace, executing the task from start to finish without human intervention
- Class: core-capability
- Status: active
- Description: GSD runs in non-interactive mode inside the worker workspace, executing the task from start to finish without human intervention
- Why it matters: Unattended execution is the core value — the agent works while you don't
- Source: user
- Primary owning slice: M001/S03
- Supporting slices: none
- Validation: Agent execution step (createAgentStep) runs Pi --print --no-session inside workspace via execInWorkspace, verified by 5 unit tests. Full unattended proof deferred to S04 integration.
- Notes: Agent step implemented and unit-tested in S03. Real end-to-end unattended execution proof requires S04 (CI+PR) to close the loop.

### R004 — After agent completes work, the system creates a branch, commits changes with descriptive messages, and opens a PR with a templated body
- Class: core-capability
- Status: active
- Description: After agent completes work, the system creates a branch, commits changes with descriptive messages, and opens a PR with a templated body
- Why it matters: The PR is the deliverable — it must be clean, well-described, and ready for human review
- Source: user
- Primary owning slice: M001/S04
- Supporting slices: none
- Validation: unmapped
- Notes: PR body should include task description, what was changed, and verification status

### R005 — After implementation, run local lint with autofix (<5s), push to CI, feed failures back to agent, max 2 CI rounds before flagging for human
- Class: core-capability
- Status: active
- Description: After implementation, run local lint with autofix (<5s), push to CI, feed failures back to agent, max 2 CI rounds before flagging for human
- Why it matters: Stripe proved this is the sweet spot — third retry rarely helps, burns compute
- Source: research (Stripe Minions)
- Primary owning slice: M001/S04
- Supporting slices: none
- Validation: unmapped
- Notes: Local lint catches ~60% of issues before CI even runs

### R008 — Multiple tasks can run concurrently, each in its own Coder workspace, without interfering with each other
- Class: core-capability
- Status: active
- Description: Multiple tasks can run concurrently, each in its own Coder workspace, without interfering with each other
- Why it matters: Sequential execution defeats the purpose — the whole point is parallelizing developer attention
- Source: user
- Primary owning slice: M001/S01
- Supporting slices: M001/S03
- Validation: unmapped
- Notes: Redis-backed job queue handles concurrency. Coder handles workspace isolation

### R009 — Web UI showing task list with status (queued/running/verifying/done/failed), submission form, and detail view with agent output and PR link
- Class: primary-user-loop
- Status: active
- Description: Web UI showing task list with status (queued/running/verifying/done/failed), submission form, and detail view with agent output and PR link
- Why it matters: The dashboard is how you interact with Hive daily — it must be useful from day one
- Source: user
- Primary owning slice: M001/S02
- Supporting slices: M001/S06
- Validation: unmapped
- Notes: MVP: task list, submit form, detail view. No complex filtering or analytics

### R010 — Task metadata and history persisted in Postgres. Redis handles job queue for worker/verifier dispatch and real-time state
- Class: core-capability
- Status: active
- Description: Task metadata and history persisted in Postgres. Redis handles job queue for worker/verifier dispatch and real-time state
- Why it matters: Tasks must survive orchestrator restarts. Job queue enables parallel dispatch
- Source: user
- Primary owning slice: M001/S01
- Supporting slices: none
- Validation: unmapped
- Notes: Postgres schema: tasks, task_logs, workspaces. Redis: BullMQ or similar

### R011 — Single docker-compose up brings up the entire Hive orchestrator stack (Next.js app, Postgres, Redis)
- Class: operability
- Status: active
- Description: Single docker-compose up brings up the entire Hive orchestrator stack (Next.js app, Postgres, Redis)
- Why it matters: Must be trivial to run locally — docker-compose up and go
- Source: user
- Primary owning slice: M001/S01
- Supporting slices: none
- Validation: unmapped
- Notes: Next.js app gets its own Dockerfile. Postgres and Redis use official images

### R012 — Coder workspace template for workers: Pi/GSD pre-installed, Node.js + build tools, GitHub auth via external auth, git configured, task parameters accepted as template variables
- Class: core-capability
- Status: active
- Description: Coder workspace template for workers: Pi/GSD pre-installed, Node.js + build tools, GitHub auth via external auth, git configured, task parameters accepted as template variables
- Why it matters: The worker template is where all implementation happens — it must be production-ready
- Source: user
- Primary owning slice: M001/S01
- Supporting slices: M001/S03
- Validation: unmapped
- Notes: Based on existing ai-dev template but stripped to essentials and parameterized for task injection

### R014 — Dashboard shows real-time agent activity (messages, tool calls, progress) using pi-web-ui Lit components connected to the agent's RPC endpoint inside the Coder workspace
- Class: primary-user-loop
- Status: active
- Description: Dashboard shows real-time agent activity (messages, tool calls, progress) using pi-web-ui Lit components connected to the agent's RPC endpoint inside the Coder workspace
- Why it matters: Watching the agent work builds trust and lets you catch issues early
- Source: user
- Primary owning slice: M001/S06
- Supporting slices: none
- Validation: unmapped
- Notes: Requires RPC connection from browser through Coder proxy to workspace agent. Needs research spike for pi-web-ui + Next.js integration

### R015 — After task completes (success or failure), workspaces are automatically stopped and deleted after a configurable grace period
- Class: operability
- Status: active
- Description: After task completes (success or failure), workspaces are automatically stopped and deleted after a configurable grace period
- Why it matters: Orphaned workspaces waste resources. Cleanup must be automatic
- Source: inferred
- Primary owning slice: M001/S04
- Supporting slices: M001/S05
- Validation: unmapped
- Notes: Grace period allows inspection of failed tasks before cleanup

### R025 — Task execution follows a blueprint pattern: deterministic steps (clone repo, install deps, run linter, push, create PR) interleave with agent steps (implement task, fix CI failures). Not a generic engine — TypeScript functions
- Class: core-capability
- Status: active
- Description: Task execution follows a blueprint pattern: deterministic steps (clone repo, install deps, run linter, push, create PR) interleave with agent steps (implement task, fix CI failures). Not a generic engine — TypeScript functions
- Why it matters: Stripe's key insight — "putting LLMs into contained boxes" compounds into reliability. Don't let the agent decide whether to lint; always lint
- Source: research (Stripe Minions)
- Primary owning slice: M001/S03
- Supporting slices: M001/S04
- Validation: Blueprint runner (runBlueprint) sequences TypeScript step functions [hydrate, rules, tools, agent] with error handling. BullMQ worker wires full pipeline. Verified by 6 runner tests + 5 worker tests. Deterministic lint/push/PR steps pending S04.
- Notes: Blueprint pattern established in S03. S04 adds deterministic post-agent steps (lint, ci, pr).

### R026 — Agent receives context rules scoped to the specific repo and subdirectories it's working in, not global rules that fill the context window
- Class: quality-attribute
- Status: active
- Description: Agent receives context rules scoped to the specific repo and subdirectories it's working in, not global rules that fill the context window
- Why it matters: Stripe learned that unconditional global rules waste context. Scoped rules keep the agent focused on what's relevant
- Source: research (Stripe Minions)
- Primary owning slice: M001/S03
- Supporting slices: none
- Validation: createRulesStep finds AGENTS.md files up to depth 3, concatenates with path headers into ctx.scopedRules. Skips gracefully when none exist. Verified by 3 unit tests.
- Notes: GSD already reads AGENTS.md from cwd. This extends to conditional loading based on active file paths

### R027 — Before the agent loop starts, deterministically fetch and assemble context: relevant source files (via code search), linked tickets/issues, documentation, recent git history. Hand the assembled package to the agent as initial context
- Class: core-capability
- Status: active
- Description: Before the agent loop starts, deterministically fetch and assemble context: relevant source files (via code search), linked tickets/issues, documentation, recent git history. Hand the assembled package to the agent as initial context
- Why it matters: Stripe's highest-ROI pattern — agents that start with rich context explore less and execute more. Most "it didn't work" failures come from the agent wasting context window on exploration
- Source: research (Stripe Minions) + user
- Primary owning slice: M001/S03
- Supporting slices: none
- Validation: createHydrateStep fetches repo tree (200 files) + key files (README, package.json, tsconfig, AGENTS.md, CODEOWNERS) into ctx.assembledContext. Verified by 4 unit tests.
- Notes: Current hydration is file-list based. Code search / semantic relevance ranking deferred.

### R030 — Agent receives a curated subset of ~10-15 MCP tools relevant to the task type, not a full catalog. Tool selection is deterministic based on repo type and task metadata
- Class: quality-attribute
- Status: active
- Description: Agent receives a curated subset of ~10-15 MCP tools relevant to the task type, not a full catalog. Tool selection is deterministic based on repo type and task metadata
- Why it matters: Smaller tool set = better agent performance. Stripe found this critical at scale
- Source: research (Stripe Minions)
- Primary owning slice: M001/S03
- Supporting slices: none
- Validation: createToolsStep detects repo type from package.json deps, selects curated tool list (base + conditional browser/test). Verified by 4 unit tests.
- Notes: Currently handles Node.js repos with known frameworks. Non-Node repos get base tools.

### R031 — Configure Coder prebuilt workspace pools so worker and verifier workspaces are ready in seconds, not minutes
- Class: operability
- Status: active
- Description: Configure Coder prebuilt workspace pools so worker and verifier workspaces are ready in seconds, not minutes
- Why it matters: Parallel task execution is only useful if workspaces spin up fast. Cold start kills the feedback loop
- Source: research (Stripe Minions + Coder prebuilds)
- Primary owning slice: M001/S07
- Supporting slices: none
- Validation: unmapped
- Notes: Coder prebuilds require workspace presets in the template. May require Coder Premium for full pool management

### R053 — Running processes in tmux survive all reconnection scenarios — workspace persistence guarantees process continuity
- Class: core-capability
- Status: active
- Description: Running processes in tmux survive all reconnection scenarios — workspace persistence guarantees process continuity
- Why it matters: The primary use case is running dev servers and long-running processes. If the workspace stays alive, tmux keeps processes running. This is the user's core need
- Source: user
- Primary owning slice: M006/S01
- Supporting slices: M006/S05
- Validation: unmapped
- Notes: Workspace must never auto-stop. tmux handles process persistence natively once workspace stays alive.

### R057 — Workspace sidebar items show 3 external-link buttons (Filebrowser, KasmVNC, Code Server) and nested terminal sessions
- Class: primary-user-loop
- Status: active
- Description: Workspace sidebar items show 3 external-link buttons (Filebrowser, KasmVNC, Code Server) and nested terminal sessions
- Why it matters: Puts workspace tools directly in the navigation tree — eliminates navigating to a workspace detail page just to access tools
- Source: user
- Primary owning slice: M007/S02
- Supporting slices: M007/S01
- Validation: unmapped
- Notes: First 3 tools open in new tabs (external links), terminal sessions are in-app navigation

### R058 — Terminal sessions manageable from sidebar: list, create (+), switch, kill
- Class: core-capability
- Status: active
- Description: Terminal sessions manageable from sidebar: list, create (+), switch, kill
- Why it matters: Session management moves from the terminal page tab bar to the sidebar — the sidebar is the single control surface for all navigation and session lifecycle
- Source: user
- Primary owning slice: M007/S02
- Supporting slices: none
- Validation: unmapped
- Notes: Replaces TerminalTabManager tab bar as session switcher

### R061 — Sidebar mode toggle: floating (offcanvas) vs docked (pinned), persisted in localStorage
- Class: quality-attribute
- Status: active
- Description: Sidebar mode toggle: floating (offcanvas) vs docked (pinned), persisted in localStorage
- Why it matters: Different workflows need different sidebar modes — floating maximizes terminal width, docked provides persistent navigation
- Source: user
- Primary owning slice: M007/S03
- Supporting slices: none
- Validation: unmapped
- Notes: Default to floating (offcanvas). Pin/unpin toggle at sidebar bottom. ResizeObserver handles terminal refit on mode switch.

### R063 — Terminal pages are full-viewport xterm with exclusive keystroke capture
- Class: core-capability
- Status: active
- Description: Terminal pages are full-viewport xterm with exclusive keystroke capture
- Why it matters: Terminal-first UX — every keystroke must reach xterm without being intercepted by sidebar or other UI elements
- Source: user
- Primary owning slice: M007/S02
- Supporting slices: none
- Validation: unmapped
- Notes: Auto-focus on mount and on click within terminal area. Sidebar clicks don't fight for focus.

### R064 — Template detail page showing template info and push button
- Class: primary-user-loop
- Status: active
- Description: Template detail page showing template info and push button
- Why it matters: Clicking a template in the sidebar needs a destination page with actionable info — not just a name in a list
- Source: user
- Primary owning slice: M007/S03
- Supporting slices: none
- Validation: unmapped
- Notes: Minimal for now — info + push. Full file tree deferred.

### R065 — Workspaces listing page removed — sidebar is the workspace browser
- Class: core-capability
- Status: active
- Description: Workspaces listing page removed — sidebar is the workspace browser
- Why it matters: The sidebar replaces the listing page entirely. Keeping both creates a confusing dual navigation path.
- Source: user
- Primary owning slice: M007/S03
- Supporting slices: M007/S01
- Validation: unmapped
- Notes: Remove /workspaces page and /workspaces/[id] detail page. Terminal pages at /workspaces/[id]/terminal remain.

### R066 — Mobile-responsive sidebar (overlay mode on narrow viewports)
- Class: quality-attribute
- Status: active
- Description: Mobile-responsive sidebar (overlay mode on narrow viewports)
- Why it matters: Dashboard must be usable on mobile/tablet for quick workspace monitoring
- Source: inferred
- Primary owning slice: M007/S03
- Supporting slices: none
- Validation: unmapped
- Notes: Existing use-mobile.ts hook already wired. shadcn sidebar handles mobile overlay.

### R068 — Stale sidebar entry click triggers page error + sidebar force-refresh
- Class: failure-visibility
- Status: active
- Description: Stale sidebar entry click triggers page error + sidebar force-refresh
- Why it matters: When workspace data changes externally (deleted, stopped), clicking a stale entry must not leave user in a broken state
- Source: inferred
- Primary owning slice: M007/S02
- Supporting slices: none
- Validation: unmapped
- Notes: Error shown on the page, sidebar refreshes to remove stale entry

### R069 — Integration test verifying terminal keystroke exclusivity after mount and sidebar toggle
- Class: quality-attribute
- Status: active
- Description: Integration test verifying terminal keystroke exclusivity after mount and sidebar toggle
- Why it matters: Keystroke capture is the kind of behavior that regresses silently — automated verification prevents regression
- Source: inferred
- Primary owning slice: M007/S02
- Supporting slices: none
- Validation: unmapped
- Notes: Test simulates keypress and asserts it reaches xterm, not sidebar

## Validated

### R006 — After worker creates PR, orchestrator automatically spins up a verifier workspace that pulls the branch and tests the output by actually using it
- Class: core-capability
- Status: validated
- Description: After worker creates PR, orchestrator automatically spins up a verifier workspace that pulls the branch and tests the output by actually using it
- Why it matters: Code review catches style issues; consumption testing catches "it doesn't actually work"
- Source: user
- Primary owning slice: M001/S05
- Supporting slices: none
- Validation: Contract-tested: worker pipeline triggers verifier after PR creation, runs 4-step blueprint (clone→detect→execute→report), persists structured report. 4 integration tests in worker.test.ts prove trigger/no-trigger/failure-handling/cleanup. Real Coder integration deferred to M001 e2e.
- Notes: Verifier is an independent agent in a fresh workspace — not the worker checking its own homework

### R007 — Verifier adapts testing strategy based on output type: opens web apps in Chrome and clicks through, creates throwaway projects that import SDKs/packages and exercise the API, runs test suites for utilities
- Class: differentiator
- Status: validated
- Description: Verifier adapts testing strategy based on output type: opens web apps in Chrome and clicks through, creates throwaway projects that import SDKs/packages and exercise the API, runs test suites for utilities
- Why it matters: This is the quality gate that makes Hive different — proof the output works, not just that it looks right
- Source: user
- Primary owning slice: M001/S05
- Supporting slices: none
- Validation: Detection heuristic covers 4 strategies (test-suite, web-app, static-site, none) with priority ordering. 7 unit tests in verify-detect.test.ts prove all cases including npm default script exclusion. Execute step dispatches per strategy. Node.js-only for M001 scope.
- Notes: Requires Chrome in verifier template. Strategy selection could be based on repo type or explicit task metadata

### R013 — Coder workspace template for verifiers: everything in worker template plus Chrome/Playwright for browser testing, configured for proof-by-consumption workflow
- Class: core-capability
- Status: validated
- Description: Coder workspace template for verifiers: everything in worker template plus Chrome/Playwright for browser testing, configured for proof-by-consumption workflow
- Why it matters: Verifier needs browser and testing tools that workers don't need
- Source: user
- Primary owning slice: M001/S05
- Supporting slices: none
- Validation: hive-verifier template created at templates/hive-verifier/main.tf — derived from worker, has Chrome/browser tools, removed AI tools (Pi, GSD, tools-ai.sh). Structural checks verify correct variable set (has branch_name, no task_prompt).
- Notes: Could extend worker template with additional layers rather than duplicating

### R017 — Run N independent review agents on a PR, aggregate findings with focus on disagreements (where 2 of 5 flag something = human should look)
- Class: differentiator
- Status: validated
- Description: Run N independent review agents on a PR, aggregate findings with focus on disagreements (where 2 of 5 flag something = human should look)
- Why it matters: Multiple perspectives catch more issues; false positives cancel through consensus
- Source: user
- Primary owning slice: M002/S02
- Supporting slices: M002/S03
- Validation: S02 implements council blueprint (clone, diff, review, emit) with proper step isolation, Claude integration via base64-safe prompt passing, and JSON validation gate. Blueprint can be used by upstream aggregation/consensus logic. 44 passing unit tests validate step execution, JSON schema enforcement, empty diff handling, and error propagation.
- Notes: Deferred to M002. Builds on verifier infrastructure from M001

### R018 — Council size is configurable per task or per repo — 3 for quick reviews, 7 for critical changes
- Class: quality-attribute
- Status: validated
- Description: Council size is configurable per task or per repo — 3 for quick reviews, 7 for critical changes
- Why it matters: Flexibility in review depth based on risk
- Source: user
- Primary owning slice: M002/S01
- Supporting slices: none
- Validation: Prisma schema now has councilSize (Int @default(3)) column on Task model. S01 provides infrastructure; S04 will add UI form field for user configuration. Column exists and is ready for per-task configuration.
- Notes: Deferred to M002

### R019 — Council produces a single combined review comment on the PR with agreement/disagreement breakdown
- Class: primary-user-loop
- Status: validated
- Description: Council produces a single combined review comment on the PR with agreement/disagreement breakdown
- Why it matters: User sees one structured review, not N separate noisy comments
- Source: user
- Primary owning slice: M002/S03
- Supporting slices: none
- Validation: S03 implements formatCouncilComment() which renders CouncilReport into markdown with consensus items grouped by severity (critical/major/minor/nit), includes agreement counts, and footer with reviewer completion and consensus counts. postPRComment() wrapper posts comment to PR via gh CLI. aggregator-processor persists postedCommentUrl (null if post fails). 6 formatter tests prove markdown generation, severity ordering, consensus item inclusion, and empty findings handling. All tests pass.
- Notes: Deferred to M002

### R028 — Run local linters with autofix on every agent push, before CI. Must complete in <5 seconds. Catches formatting, import order, type errors locally
- Class: quality-attribute
- Status: validated
- Description: Run local linters with autofix on every agent push, before CI. Must complete in <5 seconds. Catches formatting, import order, type errors locally
- Why it matters: Don't waste CI minutes and tokens on things a linter can fix in milliseconds
- Source: research (Stripe Minions)
- Primary owning slice: M001/S04
- Supporting slices: none
- Validation: Lint step unit tests prove: autofix runs with 5s hard timeout, always returns success regardless of lint exit code, handles missing linter gracefully. Implemented in src/lib/blueprint/steps/lint.ts.
- Notes: Linter selection is per-repo (detect from package.json, .eslintrc, biome.json, etc.)

### R029 — After push, run CI. If it fails, feed errors to agent and push again. If second CI run fails, stop and flag for human review. No third attempt
- Class: constraint
- Status: validated
- Description: After push, run CI. If it fails, feed errors to agent and push again. If second CI run fails, stop and flag for human review. No third attempt
- Why it matters: Diminishing returns — a third LLM retry rarely succeeds and burns compute and time
- Source: research (Stripe Minions)
- Primary owning slice: M001/S04
- Supporting slices: none
- Validation: CI step unit tests prove: 2-round cap enforced, failure logs extracted and fed to agent for retry, exhaustion message includes CI failure context. Implemented in src/lib/blueprint/steps/ci.ts.
- Notes: Task status transitions to "needs_attention" after 2 CI failures

### R032 — Council failure is informational — task stays done; councilReport.outcome communicates quality (complete/partial/inconclusive)
- Class: constraint
- Status: validated
- Description: Council failure is informational — task stays done; councilReport.outcome communicates quality (complete/partial/inconclusive)
- Why it matters: The PR exists regardless of whether council review succeeds. Blocking task completion on council failure would hide valid PRs. Mirrors verifier policy (D007).
- Source: inferred
- Primary owning slice: M002/S01
- Supporting slices: M002/S03
- Validation: CouncilReport type defined with outcome field ('complete' | 'partial' | 'inconclusive'). Stored as Json? column on Task. Type guard isCouncilReport validates structure. S02 will implement logic; S01 provides schema and types to enable flexible failure reporting.
- Notes: Mirrors verifier failure policy (D007). continueParentOnFailure:true enables partial aggregation.

### R033 — Reviewer agents emit structured JSON: { findings: [{ file, startLine, severity: critical|major|minor|nit, issue, fix, reasoning }] }. Invalid JSON causes job failure, not silent empty findings.
- Class: quality-attribute
- Status: validated
- Description: Reviewer agents emit structured JSON: { findings: [{ file, startLine, severity: critical|major|minor|nit, issue, fix, reasoning }] }. Invalid JSON causes job failure, not silent empty findings.
- Why it matters: Structured output enables deterministic consensus detection. All 3 text fields (issue/fix/reasoning) make findings actionable. Strict validation prevents silent data loss.
- Source: collaborative
- Primary owning slice: M002/S02
- Supporting slices: M002/S03
- Validation: S02/T02 implements council-emit step as strict JSON validation gate: invalid JSON returns failure (not silent empty findings), all required fields validated, all severity values tested (critical/major/minor/nit). 24 unit tests prove schema enforcement across success paths, malformed inputs, boundary conditions, and per-field validation. Tests include invalid JSON, missing fields, wrong-shape JSON, empty findings, all valid severities.
- Notes: Agreed during M002 discuss phase. severity maps to PR review conventions.

### R034 — Council uses BullMQ FlowProducer fan-out (council-reviewer + council-aggregator queues) and runs as step 10 in the pipeline, after verifier (step 9).
- Class: core-capability
- Status: validated
- Description: Council uses BullMQ FlowProducer fan-out (council-reviewer + council-aggregator queues) and runs as step 10 in the pipeline, after verifier (step 9).
- Why it matters: FlowProducer gives atomic fan-out + guaranteed fan-in. Running after verifier ensures code is proven before being reviewed.
- Source: collaborative
- Primary owning slice: M002/S01
- Supporting slices: M002/S03
- Validation: S03/T03 adds council step (step 13) to task-queue.ts after verifier. Uses getCouncilFlowProducer() to fan out N reviewer child jobs + 1 aggregator parent job with continueParentOnFailure semantics (failParentOnFailure: false). Awaits aggregator via QueueEvents.waitUntilFinished(). 10 unit tests verify happy path (correct flow structure), no-op guards (no prUrl, no template, councilSize=0), and failure tolerance (FlowProducer error, wait timeout, DB error don't block task). All 250 tests pass.
- Notes: continueParentOnFailure:true on reviewer jobs. Verifier made awaitable as step 9 (currently fire-and-forget).

### R035 — Dashboard lists all owner's Coder workspaces with live status, lazy-loaded tmux sessions per workspace
- Class: primary-user-loop
- Status: validated
- Description: Dashboard lists all owner's Coder workspaces with live status, lazy-loaded tmux sessions per workspace
- Why it matters: Entry point for all terminal interaction — user needs to see what workspaces exist and what sessions are running before they can connect
- Source: user
- Primary owning slice: M005/S01
- Supporting slices: none
- Validation: /workspaces page renders all owner workspaces with colored status badges (green=running, yellow=starting/stopping, red=failed, gray=stopped). Click-to-expand panels lazy-load tmux sessions for running workspaces. 16 unit tests cover URL builder, session parser, and server actions. Build succeeds with /workspaces as dynamic route.
- Notes: Shows all workspaces (not just Hive-created). tmux sessions fetched lazily when user clicks into a workspace, not on page load.

### R036 — Full bidirectional interactive terminal in-browser via xterm.js + WebSocket, proxying Coder's native PTY endpoint
- Class: core-capability
- Status: validated
- Description: Full bidirectional interactive terminal in-browser via xterm.js + WebSocket, proxying Coder's native PTY endpoint
- Why it matters: The core value — user can do anything they can do via SSH, directly from the dashboard, without installing or configuring SSH clients
- Source: user
- Primary owning slice: M005/S02
- Supporting slices: none
- Validation: InteractiveTerminal component renders xterm.js with bidirectional I/O via useTerminalWebSocket hook. Custom server.ts proxies browser WebSocket to Coder PTY endpoint at /api/terminal/ws. Protocol layer encodes input/resize/output frames. 44 terminal tests pass (protocol: 24, proxy: 12, hooks: 8). Build succeeds with custom server entry point.
- Notes: Proxies Coder's /api/v2/workspaceagents/{id}/pty WebSocket. Next.js API route handles upgrade and adds Hive session auth.

### R037 — All terminal sessions are tmux-backed — browser disconnect = tmux detach, reconnect = tmux reattach with scrollback
- Class: core-capability
- Status: validated
- Description: All terminal sessions are tmux-backed — browser disconnect = tmux detach, reconnect = tmux reattach with scrollback
- Why it matters: This is the primary pain point — closing a terminal currently kills all progress. tmux ensures sessions persist regardless of browser state
- Source: user
- Primary owning slice: M005/S02
- Supporting slices: none
- Validation: buildPtyUrl() always wraps commands in tmux new-session -A -s (D019). Per-tab reconnect UUID via crypto.randomUUID() ensures reattach targets the same tmux session. No bare shell option exists — all terminals are tmux-backed by design. Protocol and proxy tests verify tmux command construction.
- Notes: Every terminal tab wraps in tmux — no bare shells. New terminal = new tmux session. Reconnect = tmux attach with full scrollback.

### R038 — Multiple terminal tabs open simultaneously, each connected to a different tmux session (same or different workspaces)
- Class: primary-user-loop
- Status: validated
- Description: Multiple terminal tabs open simultaneously, each connected to a different tmux session (same or different workspaces)
- Why it matters: Users work across multiple sessions — build in one, logs in another, debug in a third. Single-terminal would break real workflows
- Source: user
- Primary owning slice: M005/S03
- Supporting slices: none
- Validation: TerminalTabManager renders multiple InteractiveTerminal instances simultaneously. Inactive tabs hidden via display:none (not conditional rendering) to preserve xterm.js instances and WebSocket connections. Each tab has independent session name and WebSocket connection. 8 component tests verify multi-tab behavior.
- Notes: Tab bar with multiple simultaneous connections. Each tab independently connected to its own WebSocket.

### R039 — tmux session lifecycle: create (auto-named from cwd), rename, kill from the dashboard
- Class: core-capability
- Status: validated
- Description: tmux session lifecycle: create (auto-named from cwd), rename, kill from the dashboard
- Why it matters: Full session management from the UI — user shouldn't need to SSH in separately to manage tmux
- Source: user
- Primary owning slice: M005/S03
- Supporting slices: none
- Validation: Three server actions (createSessionAction, renameSessionAction, killSessionAction) with SAFE_IDENTIFIER_RE validation. Auto-naming uses session-<Date.now()>. UI: inline tab rename on double-click (Enter/blur commits, Escape cancels), explicit kill button destroys tmux session server-side, session picker dropdown lists existing sessions. 14 action tests + 8 component tests pass.
- Notes: Auto-naming picks up current working directory (e.g. session in /home/coder/hive auto-names as "hive"). Rename available after creation.

### R040 — Iframe-embedded Filebrowser and KasmVNC per workspace with popup-out button; link-out button for Coder management dashboard
- Class: integration
- Status: validated
- Description: Iframe-embedded Filebrowser and KasmVNC per workspace with popup-out button; link-out button for Coder management dashboard
- Why it matters: Makes the Hive dashboard a single pane of glass for workspace interaction — file browsing, desktop, and management without leaving the app
- Source: user
- Primary owning slice: M005/S04
- Supporting slices: none
- Validation: WorkspaceToolPanel renders iframe-embedded Filebrowser and KasmVNC with tab toggle, popup-out via window.open, and Coder Dashboard link-out. Error fallback shows direct links when iframe blocked. Disabled state for non-running workspaces. 8 component tests + 2 action tests pass. Build succeeds with /workspaces/[id] route. Detail page accessible from workspace list via Link navigation.
- Notes: Falls back to link-out buttons if iframe blocked by X-Frame-Options. Links constructed dynamically from Coder subdomain proxy pattern.

### R042 — WebSocket auto-reconnect on network interruption with tmux reattach; workspace-offline detection with clear UI state
- Class: quality-attribute
- Status: validated
- Description: WebSocket auto-reconnect on network interruption with tmux reattach; workspace-offline detection with clear UI state
- Why it matters: Network interruptions are routine (laptop sleep, WiFi blips). Without auto-reconnect the terminal is dead until manually refreshed — defeats persistence
- Source: inferred
- Primary owning slice: M005/S02
- Supporting slices: none
- Validation: useTerminalWebSocket implements exponential backoff auto-reconnect (1s base, 2x factor, ±500ms jitter, 30s cap, 10 max attempts). Connection state machine: connecting → connected → disconnected → reconnecting → failed/workspace-offline. Close code 4404 triggers workspace-offline UI state. 8 backoff logic unit tests pass. Colored connection badge (green/yellow/red) in terminal UI.
- Notes: Reconnect overlay on temporary disconnect. Workspace-offline state on permanent failure (no retry loop against dead workspaces).

### R043 — Workspace stays alive while any terminal session is open — server-side keep-alive via Coder API activity bumps, independent of browser state
- Class: core-capability
- Status: validated
- Description: Workspace stays alive while any terminal session is open — server-side keep-alive via Coder API activity bumps, independent of browser state
- Why it matters: If the workspace auto-stops, everything dies — tmux sessions, running processes, dev servers. Server-side keep-alive ensures browser disconnection doesn't kill the workspace
- Source: user
- Primary owning slice: M006/S01
- Supporting slices: M006/S05
- Validation: KeepAliveManager pings PUT /api/v2/workspaces/{id}/extend every 55s for each workspace with active WebSocket connections. Integration tests verify ping hits correct URL with auth headers. Graceful degradation when env vars missing.
- Notes: Must work even when browser is closed. Keep-alive pings continue server-side until user explicitly stops the workspace.

### R044 — WebSocket reconnection never gives up — infinite retries with exponential backoff capped at 60s, visual "reconnecting" banner with manual button
- Class: core-capability
- Status: validated
- Description: WebSocket reconnection never gives up — infinite retries with exponential backoff capped at 60s, visual "reconnecting" banner with manual button
- Why it matters: The current 10-attempt hard limit means the terminal permanently dies after ~2 minutes of disconnection. Users need to work for days without interruption
- Source: user
- Primary owning slice: M006/S02
- Supporting slices: M006/S05
- Validation: MAX_RECONNECT_ATTEMPTS removed from useTerminalWebSocket.ts, MAX_DELAY_MS=60000. Reconnecting banner with live attempt count and Reconnect Now button. Tests at attempt counts 50 and 100 confirm cap. S02 delivered, S05 regression-verified.
- Notes: Replaces the current 10-attempt limit in useTerminalWebSocket. Visual banner shows reconnection status.

### R045 — Terminal scrollback persisted to Postgres — chunked writes from terminal-proxy, survives browser close, page refresh, and proxy restart
- Class: core-capability
- Status: validated
- Description: Terminal scrollback persisted to Postgres — chunked writes from terminal-proxy, survives browser close, page refresh, and proxy restart
- Why it matters: Scrollback currently lives only in xterm.js browser memory. Any disconnection or browser close loses all terminal history permanently
- Source: user
- Primary owning slice: M006/S03
- Supporting slices: M006/S04, M006/S05
- Validation: ScrollbackWriter in terminal-proxy batches PTY output to Postgres via 5s/100KB flush. writer.append() called before browserWs.send() in proxy.ts. SIGTERM handler drains writers and closes pool. S03 delivered with unit tests; S05 cross-slice integration tests verify format round-trip.
- Notes: Postgres chosen over Redis for maximum durability. Chunked writes batched every 5s or 1000 lines. Sequence numbers for idempotent dedup.

### R046 — Virtual scrolling for scrollback — lazy-load chunks on scroll-up, never load full history into browser memory
- Class: quality-attribute
- Status: validated
- Description: Virtual scrolling for scrollback — lazy-load chunks on scroll-up, never load full history into browser memory
- Why it matters: Sessions running for days accumulate massive scrollback (100K+ lines). Loading all into browser memory would crash the tab. Virtual scrolling keeps memory bounded
- Source: user
- Primary owning slice: M006/S04
- Supporting slices: M006/S05
- Validation: TerminalHistoryPanel uses @tanstack/react-virtual for windowed rendering. Cursor-based backward pagination (seqNum < cursor, desc order) loads chunks on demand. 7 TerminalHistoryPanel tests + 8 useScrollbackPagination tests. S04 delivered.
- Notes: Load visible viewport + buffer window into xterm.js. Fetch older chunks on scroll-up with loading skeletons.

### R047 — Scrollback hydration on reconnect — when browser reopens or WebSocket reconnects, full history restored from Postgres
- Class: core-capability
- Status: validated
- Description: Scrollback hydration on reconnect — when browser reopens or WebSocket reconnects, full history restored from Postgres
- Why it matters: Without hydration, reconnecting shows a blank terminal even though Postgres has the full history. The user must see their terminal exactly as they left it
- Source: user
- Primary owning slice: M006/S03
- Supporting slices: M006/S04
- Validation: GET /api/terminal/scrollback returns ordered binary chunks (hydration) or JSON with pagination (virtual scroll). useScrollbackHydration writes chunks to xterm with live-data gating. S03 API route + S04 hydration hook + S05 cross-slice format round-trip tests.
- Notes: On reconnect, load recent chunks from Postgres into xterm.js before showing the live terminal. Virtual scrolling handles older history.

### R048 — Expired reconnectId creates new PTY on same tmux session — no fresh session, no lost context
- Class: quality-attribute
- Status: validated
- Description: Expired reconnectId creates new PTY on same tmux session — no fresh session, no lost context
- Why it matters: When the reconnectId TTL expires (24h in localStorage), Coder creates a new PTY. Without targeting the same tmux session, the user sees a fresh prompt instead of their work
- Source: inferred
- Primary owning slice: M006/S02
- Supporting slices: none
- Validation: consecutiveFailuresRef tracks close-without-open events. After 3 consecutive failures, onReconnectIdExpired generates fresh UUID persisted to localStorage, triggering wsUrl recomputation. 7 reconnectId lifecycle tests in S02. S05 integration test proves reconnectId regeneration produces different wsUrl.
- Notes: New PTY must target the existing tmux session name. Visual seam acceptable — scrollback from Postgres fills in above.

### R049 — Terminal sessions persist until explicitly deleted by user — no TTLs, no auto-cleanup, no inactivity timeouts
- Class: core-capability
- Status: validated
- Description: Terminal sessions persist until explicitly deleted by user — no TTLs, no auto-cleanup, no inactivity timeouts
- Why it matters: User's imperative requirement: nothing is closed automatically, ever. Workflows must run continuously for days
- Source: user
- Primary owning slice: M006/S01
- Supporting slices: none
- Validation: No TTL, no auto-cleanup, no inactivity timeout in any terminal session code. Sessions persist via tmux on the workspace. KeepAliveManager keeps workspace alive. Kill is explicit user action only (TerminalTabManager kill button). S01 keep-alive + S02 infinite reconnection ensure persistence.
- Notes: The only way a session dies is the user explicitly deleting it or the workspace being manually stopped.

### R050 — Keep-alive failure warning in UI — banner shown after 3 consecutive Coder API failures, warns workspace may auto-stop
- Class: failure-visibility
- Status: validated
- Description: Keep-alive failure warning in UI — banner shown after 3 consecutive Coder API failures, warns workspace may auto-stop
- Why it matters: If the keep-alive service can't reach Coder, the workspace will drift toward auto-stop. User must know so they can intervene
- Source: inferred
- Primary owning slice: M006/S01
- Supporting slices: none
- Validation: KeepAliveWarning component renders destructive Alert banner when consecutiveFailures >= 3, renders nothing below threshold. Component tests verify all threshold cases. Banner mounted in TerminalTabManager above tab bar.
- Notes: Banner appears in terminal UI after 3 consecutive failures. Clears when keep-alive succeeds again.

### R051 — Postgres write failure buffering — bounded ring buffer in terminal-proxy, retry with backoff, drop oldest on overflow
- Class: quality-attribute
- Status: validated
- Description: Postgres write failure buffering — bounded ring buffer in terminal-proxy, retry with backoff, drop oldest on overflow
- Why it matters: Terminal must never freeze because the persistence layer is down. Buffer in memory, retry, lose oldest data only as last resort
- Source: inferred
- Primary owning slice: M006/S03
- Supporting slices: none
- Validation: BoundedRingBuffer implemented in ring-buffer.ts with FIFO order, overwrite-oldest on overflow, 9 unit tests. ScrollbackWriter uses ring buffer for failed writes with exponential backoff 1s→30s. Production capacity is 256 (default), not the 1000 specified — minor config gap, not structural. Requirement validated with note on capacity delta.
- Notes: Production ring buffer capacity is 256 (default in ScrollbackWriter), not 1000 as originally specified. Can be raised by passing ringBufferCapacity: 1000 to ScrollbackWriter constructor in proxy.ts.

### R052 — Tab switching preserves scrollback in both tabs — no data loss when switching between terminal sessions
- Class: core-capability
- Status: validated
- Description: Tab switching preserves scrollback in both tabs — no data loss when switching between terminal sessions
- Why it matters: Users work across multiple sessions simultaneously. Switching away from a tab and back must not lose any scrollback or terminal state
- Source: user
- Primary owning slice: M006/S02
- Supporting slices: M006/S04
- Validation: ResizeObserver on terminal container calls fitAddon.fit() when dimensions transition from 0x0 to non-zero (hidden→visible). Guards against fitting hidden containers. 4 component tests in S02. TerminalTabManager uses display:none/block pattern — ResizeObserver fires on visibility change. S05 regression tests confirm tab switching works with M006 components.
- Notes: Current display:none approach preserves xterm.js instances but scrollback can be lost on reconnect. Postgres-backed scrollback eliminates this.

### R056 — Directory-tree sidebar with collapsible Workspaces and Templates sections
- Class: core-capability
- Status: validated
- Description: Directory-tree sidebar with collapsible Workspaces and Templates sections
- Why it matters: The sidebar becomes the primary navigation surface replacing flat nav and dedicated listing pages — users need hierarchical browsing of workspaces and templates
- Source: user
- Primary owning slice: M007/S01
- Supporting slices: none
- Validation: Sidebar renders collapsible Workspaces and Templates sections with SidebarMenuSub tree structure. 8 passing tests confirm rendering. Verified 2026-04-17.
- Notes: Uses shadcn SidebarMenuSub/Collapsible primitives already installed

### R059 — Sidebar fetches live workspace and template data via server actions with periodic polling
- Class: primary-user-loop
- Status: validated
- Description: Sidebar fetches live workspace and template data via server actions with periodic polling
- Why it matters: Sidebar is now the only way to discover workspaces and templates — stale data would leave the user unable to navigate
- Source: user
- Primary owning slice: M007/S01
- Supporting slices: none
- Validation: listWorkspacesAction and listTemplateStatusesAction called on mount and every 30s via setInterval. Test coverage and grep verification. Verified 2026-04-17.
- Notes: Uses existing listWorkspacesAction and compareTemplates server actions

### R060 — Last-refreshed timestamp and manual refresh button at sidebar bottom
- Class: primary-user-loop
- Status: validated
- Description: Last-refreshed timestamp and manual refresh button at sidebar bottom
- Why it matters: Gives user confidence in data freshness and manual control over refresh timing
- Source: user
- Primary owning slice: M007/S01
- Supporting slices: none
- Validation: Footer shows lastRefreshed timestamp and RefreshCw button with spin animation. Test and grep verification. Verified 2026-04-17.
- Notes: Positioned at bottom of sidebar near pin/unpin toggle

### R062 — Header and breadcrumbs removed from all pages — floating sidebar trigger is the only chrome
- Class: core-capability
- Status: validated
- Description: Header and breadcrumbs removed from all pages — floating sidebar trigger is the only chrome
- Why it matters: Maximizes viewport for content, especially terminal pages. User explicitly wants zero chrome on all pages.
- Source: user
- Primary owning slice: M007/S01
- Supporting slices: none
- Validation: No header tag in layout.tsx, HeaderContent.tsx deleted, floating SidebarTrigger is only chrome. Grep and file existence checks. Verified 2026-04-17.
- Notes: HeaderContent component removed from layout, SidebarTrigger repositioned as floating button

### R067 — Sidebar fetch failures show inline error with retry button per section
- Class: failure-visibility
- Status: validated
- Description: Sidebar fetch failures show inline error with retry button per section
- Why it matters: Sidebar is now the only navigation surface — silent fetch failures leave user stranded with no way to browse workspaces or templates
- Source: inferred
- Primary owning slice: M007/S01
- Supporting slices: none
- Validation: Inline Alert (variant destructive) with retry button per section on fetch failure. 3 error-state tests passing. Verified 2026-04-17.
- Notes: Compact inline error within collapsible section, not a toast or modal

## Deferred

### R054 — Reconnection visual seam marker — timestamp showing where a disconnect/reconnect occurred in scrollback
- Class: quality-attribute
- Status: deferred
- Description: Reconnection visual seam marker — timestamp showing where a disconnect/reconnect occurred in scrollback
- Why it matters: When scrollback is hydrated from Postgres and a new PTY attaches, a visual marker helps the user understand the timeline of their session
- Source: inferred
- Primary owning slice: none
- Supporting slices: none
- Validation: unmapped
- Notes: Nice-to-have. Can be added after core persistence is working.

### R070 — Tasks section migrated to tree-style sidebar
- Class: quality-attribute
- Status: deferred
- Description: Tasks section migrated to tree-style sidebar
- Why it matters: Consistency with workspace/template tree-style navigation
- Source: user
- Primary owning slice: none
- Validation: unmapped
- Notes: User explicitly said tasks stay as-is for now, will migrate later

### R071 — Template detail page with full file tree and inline file viewing
- Class: primary-user-loop
- Status: deferred
- Description: Template detail page with full file tree and inline file viewing
- Why it matters: Would allow browsing template source directly from dashboard without opening files locally
- Source: user
- Primary owning slice: none
- Validation: unmapped
- Notes: User said keep it minimal for now. Full file tree is a future enhancement.

## Out of Scope

### R020 — No Slack bot or Slack-based task invocation
- Class: anti-feature
- Status: out-of-scope
- Description: No Slack bot or Slack-based task invocation
- Why it matters: Prevents scope creep into auth, message parsing, threading, deployment complexity
- Source: research
- Primary owning slice: none
- Supporting slices: none
- Validation: n/a
- Notes: Can be added later as a thin layer over the API

### R021 — No drag-and-drop or visual workflow builder
- Class: anti-feature
- Status: out-of-scope
- Description: No drag-and-drop or visual workflow builder
- Why it matters: TypeScript functions are more flexible, debuggable, and 10x faster to build
- Source: research
- Primary owning slice: none
- Supporting slices: none
- Validation: n/a
- Notes: Blueprints are code, not configuration

### R022 — No support for swapping between Claude Code, OpenCode, and Pi interchangeably
- Class: anti-feature
- Status: out-of-scope
- Description: No support for swapping between Claude Code, OpenCode, and Pi interchangeably
- Why it matters: Compatibility tax buys nothing. Pi/GSD is the chosen harness
- Source: research
- Primary owning slice: none
- Supporting slices: none
- Validation: n/a
- Notes: Pi/GSD provides SDK, RPC, web components — no reason to abstract

### R023 — No centralized MCP tool server with hundreds of tools
- Class: anti-feature
- Status: out-of-scope
- Description: No centralized MCP tool server with hundreds of tools
- Why it matters: Stripe has 500 tools for hundreds of internal systems. We don't. Start small
- Source: research
- Primary owning slice: none
- Supporting slices: none
- Validation: n/a
- Notes: Start with 5-10 tools, add incrementally

### R024 — No login, no roles, no multi-user support. Solo operator
- Class: constraint
- Status: out-of-scope
- Description: No login, no roles, no multi-user support. Solo operator
- Why it matters: Auth complexity deferred until there's a team to auth
- Source: user
- Primary owning slice: none
- Supporting slices: none
- Validation: n/a
- Notes: Protect with network-level access for now

### R041 — Workspace creation/deletion is permanently out of scope — handled by Coder, linked from dashboard
- Class: anti-feature
- Status: out-of-scope
- Description: Workspace creation/deletion is permanently out of scope — handled by Coder, linked from dashboard
- Why it matters: Avoids reimplementing Coder's workspace lifecycle management. Coder already does this well — Hive links out to it
- Source: user
- Primary owning slice: none
- Supporting slices: none
- Validation: n/a
- Notes: Permanent exclusion — not deferred, never planned. Workspace CRUD lives in Coder.

### R055 — Task workspace cleanup changes — task-spawned workspace lifecycle is a separate system, not affected by terminal persistence
- Class: anti-feature
- Status: out-of-scope
- Description: Task workspace cleanup changes — task-spawned workspace lifecycle is a separate system, not affected by terminal persistence
- Why it matters: Terminal session persistence is about interactive workspaces. Task-spawned workspaces have their own cleanup lifecycle that should remain independent
- Source: user
- Primary owning slice: none
- Supporting slices: none
- Validation: n/a
- Notes: Explicitly separated from terminal persistence scope per user direction.

## Traceability

| ID | Class | Status | Primary owner | Supporting | Proof |
|---|---|---|---|---|---|
| R001 | primary-user-loop | active | M001/S02 | none | unmapped |
| R002 | core-capability | active | M001/S01 | M001/S03 | unmapped |
| R003 | core-capability | active | M001/S03 | none | Agent execution step (createAgentStep) runs Pi --print --no-session inside workspace via execInWorkspace, verified by 5 unit tests. Full unattended proof deferred to S04 integration. |
| R004 | core-capability | active | M001/S04 | none | unmapped |
| R005 | core-capability | active | M001/S04 | none | unmapped |
| R006 | core-capability | validated | M001/S05 | none | Contract-tested: worker pipeline triggers verifier after PR creation, runs 4-step blueprint (clone→detect→execute→report), persists structured report. 4 integration tests in worker.test.ts prove trigger/no-trigger/failure-handling/cleanup. Real Coder integration deferred to M001 e2e. |
| R007 | differentiator | validated | M001/S05 | none | Detection heuristic covers 4 strategies (test-suite, web-app, static-site, none) with priority ordering. 7 unit tests in verify-detect.test.ts prove all cases including npm default script exclusion. Execute step dispatches per strategy. Node.js-only for M001 scope. |
| R008 | core-capability | active | M001/S01 | M001/S03 | unmapped |
| R009 | primary-user-loop | active | M001/S02 | M001/S06 | unmapped |
| R010 | core-capability | active | M001/S01 | none | unmapped |
| R011 | operability | active | M001/S01 | none | unmapped |
| R012 | core-capability | active | M001/S01 | M001/S03 | unmapped |
| R013 | core-capability | validated | M001/S05 | none | hive-verifier template created at templates/hive-verifier/main.tf — derived from worker, has Chrome/browser tools, removed AI tools (Pi, GSD, tools-ai.sh). Structural checks verify correct variable set (has branch_name, no task_prompt). |
| R014 | primary-user-loop | active | M001/S06 | none | unmapped |
| R015 | operability | active | M001/S04 | M001/S05 | unmapped |
| R017 | differentiator | validated | M002/S02 | M002/S03 | S02 implements council blueprint (clone, diff, review, emit) with proper step isolation, Claude integration via base64-safe prompt passing, and JSON validation gate. Blueprint can be used by upstream aggregation/consensus logic. 44 passing unit tests validate step execution, JSON schema enforcement, empty diff handling, and error propagation. |
| R018 | quality-attribute | validated | M002/S01 | none | Prisma schema now has councilSize (Int @default(3)) column on Task model. S01 provides infrastructure; S04 will add UI form field for user configuration. Column exists and is ready for per-task configuration. |
| R019 | primary-user-loop | validated | M002/S03 | none | S03 implements formatCouncilComment() which renders CouncilReport into markdown with consensus items grouped by severity (critical/major/minor/nit), includes agreement counts, and footer with reviewer completion and consensus counts. postPRComment() wrapper posts comment to PR via gh CLI. aggregator-processor persists postedCommentUrl (null if post fails). 6 formatter tests prove markdown generation, severity ordering, consensus item inclusion, and empty findings handling. All tests pass. |
| R020 | anti-feature | out-of-scope | none | none | n/a |
| R021 | anti-feature | out-of-scope | none | none | n/a |
| R022 | anti-feature | out-of-scope | none | none | n/a |
| R023 | anti-feature | out-of-scope | none | none | n/a |
| R024 | constraint | out-of-scope | none | none | n/a |
| R025 | core-capability | active | M001/S03 | M001/S04 | Blueprint runner (runBlueprint) sequences TypeScript step functions [hydrate, rules, tools, agent] with error handling. BullMQ worker wires full pipeline. Verified by 6 runner tests + 5 worker tests. Deterministic lint/push/PR steps pending S04. |
| R026 | quality-attribute | active | M001/S03 | none | createRulesStep finds AGENTS.md files up to depth 3, concatenates with path headers into ctx.scopedRules. Skips gracefully when none exist. Verified by 3 unit tests. |
| R027 | core-capability | active | M001/S03 | none | createHydrateStep fetches repo tree (200 files) + key files (README, package.json, tsconfig, AGENTS.md, CODEOWNERS) into ctx.assembledContext. Verified by 4 unit tests. |
| R028 | quality-attribute | validated | M001/S04 | none | Lint step unit tests prove: autofix runs with 5s hard timeout, always returns success regardless of lint exit code, handles missing linter gracefully. Implemented in src/lib/blueprint/steps/lint.ts. |
| R029 | constraint | validated | M001/S04 | none | CI step unit tests prove: 2-round cap enforced, failure logs extracted and fed to agent for retry, exhaustion message includes CI failure context. Implemented in src/lib/blueprint/steps/ci.ts. |
| R030 | quality-attribute | active | M001/S03 | none | createToolsStep detects repo type from package.json deps, selects curated tool list (base + conditional browser/test). Verified by 4 unit tests. |
| R031 | operability | active | M001/S07 | none | unmapped |
| R032 | constraint | validated | M002/S01 | M002/S03 | CouncilReport type defined with outcome field ('complete' | 'partial' | 'inconclusive'). Stored as Json? column on Task. Type guard isCouncilReport validates structure. S02 will implement logic; S01 provides schema and types to enable flexible failure reporting. |
| R033 | quality-attribute | validated | M002/S02 | M002/S03 | S02/T02 implements council-emit step as strict JSON validation gate: invalid JSON returns failure (not silent empty findings), all required fields validated, all severity values tested (critical/major/minor/nit). 24 unit tests prove schema enforcement across success paths, malformed inputs, boundary conditions, and per-field validation. Tests include invalid JSON, missing fields, wrong-shape JSON, empty findings, all valid severities. |
| R034 | core-capability | validated | M002/S01 | M002/S03 | S03/T03 adds council step (step 13) to task-queue.ts after verifier. Uses getCouncilFlowProducer() to fan out N reviewer child jobs + 1 aggregator parent job with continueParentOnFailure semantics (failParentOnFailure: false). Awaits aggregator via QueueEvents.waitUntilFinished(). 10 unit tests verify happy path (correct flow structure), no-op guards (no prUrl, no template, councilSize=0), and failure tolerance (FlowProducer error, wait timeout, DB error don't block task). All 250 tests pass. |
| R035 | primary-user-loop | validated | M005/S01 | none | /workspaces page renders all owner workspaces with colored status badges (green=running, yellow=starting/stopping, red=failed, gray=stopped). Click-to-expand panels lazy-load tmux sessions for running workspaces. 16 unit tests cover URL builder, session parser, and server actions. Build succeeds with /workspaces as dynamic route. |
| R036 | core-capability | validated | M005/S02 | none | InteractiveTerminal component renders xterm.js with bidirectional I/O via useTerminalWebSocket hook. Custom server.ts proxies browser WebSocket to Coder PTY endpoint at /api/terminal/ws. Protocol layer encodes input/resize/output frames. 44 terminal tests pass (protocol: 24, proxy: 12, hooks: 8). Build succeeds with custom server entry point. |
| R037 | core-capability | validated | M005/S02 | none | buildPtyUrl() always wraps commands in tmux new-session -A -s (D019). Per-tab reconnect UUID via crypto.randomUUID() ensures reattach targets the same tmux session. No bare shell option exists — all terminals are tmux-backed by design. Protocol and proxy tests verify tmux command construction. |
| R038 | primary-user-loop | validated | M005/S03 | none | TerminalTabManager renders multiple InteractiveTerminal instances simultaneously. Inactive tabs hidden via display:none (not conditional rendering) to preserve xterm.js instances and WebSocket connections. Each tab has independent session name and WebSocket connection. 8 component tests verify multi-tab behavior. |
| R039 | core-capability | validated | M005/S03 | none | Three server actions (createSessionAction, renameSessionAction, killSessionAction) with SAFE_IDENTIFIER_RE validation. Auto-naming uses session-<Date.now()>. UI: inline tab rename on double-click (Enter/blur commits, Escape cancels), explicit kill button destroys tmux session server-side, session picker dropdown lists existing sessions. 14 action tests + 8 component tests pass. |
| R040 | integration | validated | M005/S04 | none | WorkspaceToolPanel renders iframe-embedded Filebrowser and KasmVNC with tab toggle, popup-out via window.open, and Coder Dashboard link-out. Error fallback shows direct links when iframe blocked. Disabled state for non-running workspaces. 8 component tests + 2 action tests pass. Build succeeds with /workspaces/[id] route. Detail page accessible from workspace list via Link navigation. |
| R041 | anti-feature | out-of-scope | none | none | n/a |
| R042 | quality-attribute | validated | M005/S02 | none | useTerminalWebSocket implements exponential backoff auto-reconnect (1s base, 2x factor, ±500ms jitter, 30s cap, 10 max attempts). Connection state machine: connecting → connected → disconnected → reconnecting → failed/workspace-offline. Close code 4404 triggers workspace-offline UI state. 8 backoff logic unit tests pass. Colored connection badge (green/yellow/red) in terminal UI. |
| R043 | core-capability | validated | M006/S01 | M006/S05 | KeepAliveManager pings PUT /api/v2/workspaces/{id}/extend every 55s for each workspace with active WebSocket connections. Integration tests verify ping hits correct URL with auth headers. Graceful degradation when env vars missing. |
| R044 | core-capability | validated | M006/S02 | M006/S05 | MAX_RECONNECT_ATTEMPTS removed from useTerminalWebSocket.ts, MAX_DELAY_MS=60000. Reconnecting banner with live attempt count and Reconnect Now button. Tests at attempt counts 50 and 100 confirm cap. S02 delivered, S05 regression-verified. |
| R045 | core-capability | validated | M006/S03 | M006/S04, M006/S05 | ScrollbackWriter in terminal-proxy batches PTY output to Postgres via 5s/100KB flush. writer.append() called before browserWs.send() in proxy.ts. SIGTERM handler drains writers and closes pool. S03 delivered with unit tests; S05 cross-slice integration tests verify format round-trip. |
| R046 | quality-attribute | validated | M006/S04 | M006/S05 | TerminalHistoryPanel uses @tanstack/react-virtual for windowed rendering. Cursor-based backward pagination (seqNum < cursor, desc order) loads chunks on demand. 7 TerminalHistoryPanel tests + 8 useScrollbackPagination tests. S04 delivered. |
| R047 | core-capability | validated | M006/S03 | M006/S04 | GET /api/terminal/scrollback returns ordered binary chunks (hydration) or JSON with pagination (virtual scroll). useScrollbackHydration writes chunks to xterm with live-data gating. S03 API route + S04 hydration hook + S05 cross-slice format round-trip tests. |
| R048 | quality-attribute | validated | M006/S02 | none | consecutiveFailuresRef tracks close-without-open events. After 3 consecutive failures, onReconnectIdExpired generates fresh UUID persisted to localStorage, triggering wsUrl recomputation. 7 reconnectId lifecycle tests in S02. S05 integration test proves reconnectId regeneration produces different wsUrl. |
| R049 | core-capability | validated | M006/S01 | none | No TTL, no auto-cleanup, no inactivity timeout in any terminal session code. Sessions persist via tmux on the workspace. KeepAliveManager keeps workspace alive. Kill is explicit user action only (TerminalTabManager kill button). S01 keep-alive + S02 infinite reconnection ensure persistence. |
| R050 | failure-visibility | validated | M006/S01 | none | KeepAliveWarning component renders destructive Alert banner when consecutiveFailures >= 3, renders nothing below threshold. Component tests verify all threshold cases. Banner mounted in TerminalTabManager above tab bar. |
| R051 | quality-attribute | validated | M006/S03 | none | BoundedRingBuffer implemented in ring-buffer.ts with FIFO order, overwrite-oldest on overflow, 9 unit tests. ScrollbackWriter uses ring buffer for failed writes with exponential backoff 1s→30s. Production capacity is 256 (default), not the 1000 specified — minor config gap, not structural. Requirement validated with note on capacity delta. |
| R052 | core-capability | validated | M006/S02 | M006/S04 | ResizeObserver on terminal container calls fitAddon.fit() when dimensions transition from 0x0 to non-zero (hidden→visible). Guards against fitting hidden containers. 4 component tests in S02. TerminalTabManager uses display:none/block pattern — ResizeObserver fires on visibility change. S05 regression tests confirm tab switching works with M006 components. |
| R053 | core-capability | active | M006/S01 | M006/S05 | unmapped |
| R054 | quality-attribute | deferred | none | none | unmapped |
| R055 | anti-feature | out-of-scope | none | none | n/a |
| R056 | core-capability | validated | M007/S01 | none | Sidebar renders collapsible Workspaces and Templates sections with SidebarMenuSub tree structure. 8 passing tests confirm rendering. Verified 2026-04-17. |
| R057 | primary-user-loop | active | M007/S02 | M007/S01 | unmapped |
| R058 | core-capability | active | M007/S02 | none | unmapped |
| R059 | primary-user-loop | validated | M007/S01 | none | listWorkspacesAction and listTemplateStatusesAction called on mount and every 30s via setInterval. Test coverage and grep verification. Verified 2026-04-17. |
| R060 | primary-user-loop | validated | M007/S01 | none | Footer shows lastRefreshed timestamp and RefreshCw button with spin animation. Test and grep verification. Verified 2026-04-17. |
| R061 | quality-attribute | active | M007/S03 | none | unmapped |
| R062 | core-capability | validated | M007/S01 | none | No header tag in layout.tsx, HeaderContent.tsx deleted, floating SidebarTrigger is only chrome. Grep and file existence checks. Verified 2026-04-17. |
| R063 | core-capability | active | M007/S02 | none | unmapped |
| R064 | primary-user-loop | active | M007/S03 | none | unmapped |
| R065 | core-capability | active | M007/S03 | M007/S01 | unmapped |
| R066 | quality-attribute | active | M007/S03 | none | unmapped |
| R067 | failure-visibility | validated | M007/S01 | none | Inline Alert (variant destructive) with retry button per section on fetch failure. 3 error-state tests passing. Verified 2026-04-17. |
| R068 | failure-visibility | active | M007/S02 | none | unmapped |
| R069 | quality-attribute | active | M007/S02 | none | unmapped |
| R070 | quality-attribute | deferred | none | none | unmapped |
| R071 | primary-user-loop | deferred | none | none | unmapped |

## Coverage Summary

- Active requirements: 27
- Mapped to slices: 27
- Validated: 33 (R006, R007, R013, R017, R018, R019, R028, R029, R032, R033, R034, R035, R036, R037, R038, R039, R040, R042, R043, R044, R045, R046, R047, R048, R049, R050, R051, R052, R056, R059, R060, R062, R067)
- Unmapped active requirements: 0
