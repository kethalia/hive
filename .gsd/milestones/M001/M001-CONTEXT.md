# M001: Minimum Viable Hive — Context

**Gathered:** 2026-03-19
**Status:** Ready for planning

## Project Description

Hive is an automated development system inspired by Stripe's Minions. It accepts tasks via a web dashboard, creates isolated Coder workspaces, runs GSD agents following a blueprint execution pattern (deterministic steps interleaved with agent loops), auto-verifies output through proof-by-consumption in separate verifier workspaces, and produces PRs ready for human review.

## Why This Milestone

This is the foundational milestone — it builds the entire task-to-PR pipeline from scratch. Without M001, nothing else works. The council review system (M002) depends on having working worker and verifier infrastructure.

## User-Visible Outcome

### When this milestone is complete, the user can:

- Open the Hive dashboard, submit a task ("fix bug X in repo Y"), attach reference files, and walk away
- Watch the agent work in real-time via live streaming in the dashboard
- Come back to find a PR created, CI passing (or flagged after 2 rounds), and a verification report confirming the output actually works
- Run multiple tasks in parallel, each in its own isolated workspace

### Entry point / environment

- Entry point: Web dashboard (Next.js app at localhost or deployed URL)
- Environment: Docker-compose (Next.js + Postgres + Redis) talking to Coder instance via API
- Live dependencies involved: Coder API, GitHub API, LLM provider (Anthropic), target repos

## Completion Class

- Contract complete means: orchestrator creates workspaces, dispatches agents, collects results, manages lifecycle — all via automated tests and integration tests against Coder API
- Integration complete means: a real task submitted via dashboard produces a real PR on a real GitHub repo, verified by a real verifier workspace
- Operational complete means: docker-compose up starts the full stack, workspaces clean up after completion, failed tasks surface in dashboard

## Final Integrated Acceptance

To call this milestone complete, we must prove:

- Submit a task via the dashboard for a real GitHub repo → worker workspace creates → GSD agent implements the change → lint + CI feedback loop runs → PR is created → verifier workspace auto-creates → verifier pulls branch and tests output behaviorally → dashboard shows the full lifecycle with live agent streaming and final results
- A second task submitted in parallel runs independently without interfering with the first
- A task that fails CI twice transitions to "needs_attention" and the dashboard reflects this clearly

## Risks and Unknowns

- **pi-web-ui + Next.js integration** — Lit web components in React have known friction (event handling, SSR, style scoping). Needs research spike in S06
- **RPC routing through Coder proxy** — Browser → Coder proxy → workspace agent RPC is unproven. May need websocket passthrough or Coder's subdomain routing
- **Coder Tasks API vs raw workspace API** — Tasks API is GA but may lack flexibility for custom blueprints. Fallback: raw workspace API + SSH exec
- **GSD headless execution** — GSD is designed for interactive use with /gsd commands. Running it fully unattended via Pi's print/RPC mode needs validation
- **Context hydration quality** — The pre-fetch step determines agent success rate. Getting the right context is an iterative problem, not a one-shot design

## Existing Codebase / Prior Art

- `ai-dev/main.tf` — Existing Coder template with Pi, GSD, Claude Code, browser vision, GitHub auth. Base for worker and verifier templates
- `ai-dev/Dockerfile` — Ubuntu 24.04 base with Docker, Chrome, Node.js, build tools. Starting point for workspace images
- `ai-dev/scripts/` — Installation scripts for tools (tools-ai.sh, tools-browser.sh, etc.). Reusable in new templates
- `web3-dev/` — Second template example showing template variation patterns

> See `.gsd/DECISIONS.md` for all architectural and pattern decisions — it is an append-only register; read it during planning, append to it during execution.

## Relevant Requirements

- R001-R015, R025-R031 — All active requirements are owned by M001 slices
- R027 (context hydration) is the highest-ROI single requirement — Stripe's most impactful pattern
- R025 (blueprint execution) is the architectural backbone — deterministic + agent interleaving
- R007 (proof-by-consumption) is the key differentiator — behavioral verification, not just code review

## Scope

### In Scope

- Next.js orchestrator app with Postgres + Redis (docker-compose)
- Task submission, monitoring, and results dashboard
- Worker Coder template derived from ai-dev
- Verifier Coder template with Chrome + testing resources
- Blueprint execution engine (TypeScript functions, not DSL)
- Context hydration pipeline (code search, docs fetch, link processing)
- CI feedback loop with 2-round cap
- PR generation with templated body
- Auto-verification via proof-by-consumption
- Live agent streaming via pi-web-ui + RPC
- Workspace lifecycle management (create, monitor, cleanup)
- Workspace pre-warming via Coder prebuilds

### Out of Scope / Non-Goals

- Council review (M002)
- Slack integration
- Visual workflow editor
- Multi-user auth
- Multi-agent harness abstraction
- Large MCP tool catalog

## Technical Constraints

- Solo operator — no auth needed, network-level access protection
- Coder instance must be running and accessible via API
- LLM provider (Anthropic) API key required
- GitHub external auth must be configured in Coder
- Docker-compose for local deployment (no Kubernetes for M001)

## Integration Points

- **Coder API** — Workspace CRUD, template management, workspace status, agent logs. REST API with session token auth
- **GitHub API** — Repository cloning, branch creation, PR creation, CI status checks. Via gh CLI inside workspaces
- **Anthropic API** — LLM inference for Pi/GSD agent execution inside workspaces
- **Pi RPC** — Agent activity streaming from workspace to dashboard. WebSocket or SSE over Coder proxy

## Open Questions

- **Coder Tasks vs raw workspace API** — Coder Tasks (coder_ai_task resource) is the official path but may be too opinionated. Raw workspace API + SSH exec is more flexible. Decision: try Tasks first, fall back to raw API if it constrains blueprint execution
- **Pi-web-ui SSR compatibility** — Lit web components need client-side rendering. Next.js SSR may require dynamic imports with ssr:false. Research in S06
- **Verifier strategy selection** — How does the verifier know whether to open a browser, import an SDK, or run tests? Decision deferred to S05 planning — likely task metadata + repo heuristics
