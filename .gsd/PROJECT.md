# Hive

## What This Is

An automated development system inspired by Stripe's Minions. Accepts task descriptions via a web dashboard, spins up isolated Coder workspaces, runs GSD agents to implement the work using a blueprint pattern (deterministic steps interleaved with agent loops), auto-verifies output through proof-by-consumption in a separate verifier workspace, and produces PRs ready for human review.

The system uses Pi/GSD as the agent harness (leveraging Pi's SDK, RPC, and pi-web-ui web components), Coder for workspace isolation and lifecycle management, and a Next.js + Tailwind dashboard backed by Postgres and Redis.

## Core Value

Unattended task-to-PR automation with behavioral verification — the system doesn't just write code, it proves the output works by consuming it in a fresh environment.

## Current State

**M001 complete.** All 7 slices delivered and verified. The full task-to-PR automation pipeline is built: dashboard submission → BullMQ dispatch → worker workspace creation → 8-step blueprint execution (hydrate → rules → tools → agent → lint → commit-push → CI → PR) → verifier workspace with adaptive strategy detection → structured verification report → live SSE streaming → dashboard results display. 148 tests across 25 files, all passing. All 22 M001 requirements validated.

**M002 in progress — 3 of 4 slices complete.**
- S01 (Terraform + Schema + Queue Setup): ✅ complete — council template, schema columns, BullMQ queues configured
- S02 (Council Reviewer Blueprint): ✅ complete — 5-step blueprint (clone → diff → review → emit) with Claude CLI integration and strict JSON validation
- S03 (Aggregation & PR Comment): ✅ complete — aggregation logic groups findings by file+line with ≥2 consensus, markdown formatting with severity sections, PR comment posting via gh CLI, step 13 integrated into task pipeline
- S04 (Council Dashboard): ⬜ remaining — UI to display CouncilResultCard with severity badge counts and consensus highlighting; task submission form with councilSize field

**M004 in progress — 2 of 3 slices complete.**
- S01 (Coder Template API Client & Staleness Engine): ✅ complete — CoderClient extended with listTemplates/getTemplateVersion/fetchTemplateFiles, deterministic local+remote hash functions, compareTemplates() returns per-template stale/current status with graceful degradation on network errors. 13 staleness tests + 15 client tests pass.
- S02 (Push Job Worker & SSE Streaming Route): ✅ complete — BullMQ push queue/worker spawns coder templates push as child process, tees output to log files with exit sentinels; POST and SSE API routes trigger and stream push jobs. 17 tests pass.
- S03 (Templates Dashboard Page with xterm.js): ⬜ remaining — depends on S01 and S02

**Operational notes:** M001 cleanup scheduler not wired to entrypoint. M002 council can run in isolation or as part of full pipeline; initial testing with 3-reviewer council works correctly with mock data. Real GitHub integration tested via mocked gh CLI; live GitHub token handling depends on environment setup during deployment.

Repository: https://github.com/kethalia/hive

## Architecture / Key Patterns

- **Orchestrator:** Next.js 15 app (docker-composed with Postgres + Redis) manages task lifecycle
- **Workspace isolation:** Coder API creates/destroys workspaces per task. Two templates: worker (with Pi/GSD) and verifier (with Chrome, no AI tools)
- **Agent harness:** GSD (built on Pi) runs inside workspaces in `--print --no-session` mode. Blueprint execution pattern from Stripe — deterministic steps (lint, push, PR) interleave with agent loops (implement, fix CI failures)
- **Stripe Minions patterns:** Context hydration before agent launch, scoped rule injection, shift-left linting (5s timeout), 2-round CI cap, curated MCP tool subsets, workspace pre-warming
- **Verification:** Proof-by-consumption — verifier workspace pulls the PR branch and actually uses the output (test-suite execution for tested repos, dev server + screenshot for web apps, inconclusive for unknown types)
- **Dashboard:** Next.js + Tailwind v4, with live agent streaming via SSE (custom React components, not pi-web-ui Lit — D009)
- **Template Management:** Staleness engine compares local template files against Coder's active version via deterministic sha256 hashing of sorted file paths + contents. Push worker spawns coder CLI as child process with log-file-based SSE streaming
- **Deployment:** Solo operator, no auth. Docker-compose: Next.js + Postgres + Redis

## Capability Contract

See `.gsd/REQUIREMENTS.md` for the explicit capability contract, requirement status, and coverage mapping.

## Milestone Sequence

- [x] M001: Minimum Viable Hive — Task-to-PR pipeline with worker + verifier + dashboard (22 requirements validated)
- [ ] M002: Council Review — N independent Claude reviewer agents analyse the PR diff in parallel, aggregate findings by consensus, post a single combined review comment
- [ ] M004: Template Management Dashboard — Web UI for viewing template staleness and pushing updates
