# M002: Council Review

**Gathered:** 2026-04-09
**Status:** Ready for planning

## Project Description

Hive is an automated development system: user submits a task via the dashboard, a worker agent implements it in an isolated Coder workspace following a blueprint pattern, a verifier agent proves the output works by consuming it in a fresh environment, and a PR is created automatically. M001 built the complete task-to-PR pipeline. M002 adds a council review stage after PR creation — N independent Claude reviewer agents read the PR diff in parallel, emit structured findings, and the orchestrator aggregates by consensus and posts a single combined GitHub PR comment.

## Why This Milestone

M001 proved the code works (verifier). M002 proves the code is correct (council). The verifier catches runtime failures; the council catches design issues, security concerns, and style problems that require judgment. The combination — behavioral verification + multi-agent review — is what makes Hive's output trustworthy enough for the human to merge without deep inspection.

## Codebase Brief

### Technology Stack

- Next.js 15 (App Router, server actions via next-safe-action v8 + zod)
- Prisma ORM + Postgres
- BullMQ + IORedis (Redis job queue)
- Coder REST API for workspace lifecycle
- TypeScript throughout, Vitest for tests
- Tailwind v4, shadcn/ui components
- `coder ssh` as the remote execution primitive (`execInWorkspace`)
- Docker Compose: Next.js app + Postgres + Redis

### Key Modules

- `src/lib/queue/task-queue.ts` — 8-step sequential pipeline. Council becomes step 10 (after verifier at step 9). The `createCouncilStep` factory follows the same `{ name, execute(ctx) }` shape.
- `src/lib/blueprint/` — Step factory pattern. Each step is `createXStep(): BlueprintStep`. Council blueprint has its own steps under `src/lib/blueprint/steps/council-*.ts`.
- `src/lib/workspace/exec.ts` — `execInWorkspace(workspace, agentName, cmd)` — the only primitive for remote workspace execution. Never throws; returns `{stdout, stderr, exitCode}`.
- `src/lib/coder/client.ts` — `CoderClient` for workspace CRUD. Council workspaces use the same client. `listWorkspaces()` available for cleanup.
- `src/lib/verification/report.ts` — Pattern for typed structured JSON stored in a Prisma Json column. `councilReport` follows this shape.
- `src/app/tasks/[id]/verification-report-card.tsx` — Component pattern. `CouncilResultCard` mirrors this.
- `templates/hive-worker/` and `templates/hive-verifier/` — Terraform templates for Coder workspaces. `hive-council` is a new template in `templates/hive-council/`.

### Patterns in Use

- Blueprint step factory: `createXStep(deps?) => BlueprintStep = { name: string, execute(ctx: BlueprintContext): Promise<StepResult> }`
- `execInWorkspace` wraps `coder ssh` and NEVER throws — always returns structured `{stdout, stderr, exitCode}`
- Base64 encoding for shell-transported strings (context files, PR bodies, agent prompts)
- Lazy singleton `getDb()` / `getRedisConnection()` for shared resources
- SSE streaming: `streamFromWorkspace` + `/api/tasks/[id]/stream/route.ts` + `AgentStreamPanel`
- `continueParentOnFailure: true` on BullMQ child jobs for resilient fan-in
- Dual-workspace lifecycle (D008): each workspace tracked independently, cleaned up in `finally`

## User-Visible Outcome

### When this milestone is complete, the user can:

- Submit a task with a council size (default 3), watch the pipeline run through worker → verifier → council
- See a `CouncilResultCard` in the task detail page showing finding counts by severity (critical/major/minor/nit) and consensus items highlighted
- Navigate to the GitHub PR and find a single combined review comment summarising council findings

### Entry point / environment

- Entry point: Dashboard at `http://localhost:3000/tasks/new` (council size field on submission form)
- Environment: Local dev via Docker Compose; council workspaces are Coder-managed
- Live dependencies: Coder API, GitHub API (gh CLI), Claude CLI (ANTHROPIC_API_KEY)

## Completion Class

- Contract complete means: Unit tests prove aggregation logic, JSON schema validation, FlowProducer fan-out pattern, and CouncilResultCard rendering
- Integration complete means: Council step fires in the real task pipeline after verifier; reviewer workspaces spin up, Claude CLI runs, PR comment is posted
- Operational complete means: Reviewer workspace cleanup fires in finally block; stale council workspaces swept by existing cleanup scheduler

## Architectural Decisions

### BullMQ FlowProducer for council fan-out

**Decision:** Use `FlowProducer` to atomically add N reviewer child jobs to `council-reviewer` queue and one aggregator parent job to `council-aggregator` queue. Parent waits in `waiting-children` state until all N reviewers complete (or `continueParentOnFailure` fires on failure).

**Rationale:** FlowProducer gives atomic fan-out + guaranteed fan-in with no polling. The `waiting-children` state is purpose-built for this pattern. `continueParentOnFailure: true` means partial results still aggregate — consistent with the "informational" failure policy (D007/R032).

**Evidence:** BullMQ docs confirm the parent/child pattern. `continueParentOnFailure` allows a parent job to start processing as soon as a child job fails, enabling partial aggregation.

**Alternatives Considered:**
- `Promise.all()` inside one pipeline step — simpler but no per-reviewer retry, harder to observe independently
- Redis pub/sub for fan-in — unnecessary complexity when FlowProducer solves it natively

### Claude CLI as reviewer agent

**Decision:** Council reviewer workspaces use `claude --print` (Anthropic's official Claude Code CLI) instead of Pi/GSD.

**Rationale:** User explicitly requested this — Pi is being deprecated in favour of Claude for all new agent work. Council is the first slice to use Claude CLI. Invocation pattern is the same: `--print` for non-interactive mode, context piped via base64-encoded temp file.

**Alternatives Considered:**
- Continue using Pi — rejected per user direction during M002 discuss phase

### hive-council Coder template (new, separate from worker/verifier)

**Decision:** Create `templates/hive-council/` as a distinct Terraform template based on hive-worker structure but with Claude CLI instead of Pi, no post-agent tools.

**Rationale:** Clean separation. Council's blueprint is read-only review. Independent template evolution without risk of breaking worker or verifier.

**Alternatives Considered:**
- Reuse hive-verifier with different parameters — rejected; verifier has Chrome/Playwright, not needed for council

### Finding schema: file, startLine, severity, issue, fix, reasoning

**Decision:** Each reviewer emits `{ findings: [{ file: string, startLine: number, severity: "critical"|"major"|"minor"|"nit", issue: string, fix: string, reasoning: string }] }`. Invalid JSON causes job failure (not empty findings).

**Rationale:** All 3 text fields (issue + fix + reasoning) make findings actionable, not just labels. Strict JSON validation prevents silent data loss. User explicitly requested issue/fix/reasoning during M002 discuss phase.

**Alternatives Considered:**
- Free-text review with best-effort parsing — rejected; aggregation requires deterministic grouping

### Aggregation by file + line number, consensus threshold ≥2

**Decision:** Findings from N reviewers grouped by `file + startLine`. Items where count ≥ 2 are `consensusItems`. Items flagged by only 1 reviewer are in `aggregated` but not highlighted.

**Rationale:** Deterministic, no extra API calls, maps to how humans think about review. Simple to unit-test exhaustively.

**Alternatives Considered:**
- Semantic similarity grouping — requires embedding/LLM; deferred to later milestone

### Council runs after verifier (step 10)

**Decision:** Verifier made awaitable (step 9). Council is step 10.

**Rationale:** Verifier proves the code works. Council reviews after proof. Sequential ordering avoids reviewing code that fails verification.

**Alternatives Considered:**
- Parallel with verifier — saves time; deferred due to orchestration complexity

### ANTHROPIC_API_KEY as Coder template variable

**Decision:** Council workspace receives `anthropic_api_key` via `coder_parameter`, injected at workspace creation by the orchestrator (same pattern as `pi_api_key` in hive-worker).

**Rationale:** Consistent with M001 pattern. Key never appears in logs or git.

## Interface Contracts

### ReviewerFinding type

```typescript
interface ReviewerFinding {
  file: string
  startLine: number
  severity: "critical" | "major" | "minor" | "nit"
  issue: string
  fix: string
  reasoning: string
}
```

### CouncilReport type (stored in tasks.councilReport)

```typescript
interface CouncilReport {
  councilSize: number
  completedReviewers: number
  reviewers: ReviewerFinding[][]
  aggregated: AggregatedFinding[]
  consensusItems: AggregatedFinding[]     // count >= 2
  postedCommentUrl: string | null
  outcome: "complete" | "partial" | "inconclusive"
}

interface AggregatedFinding extends ReviewerFinding {
  count: number
  reviewerIndices: number[]
}
```

### Prisma schema additions

```prisma
model Task {
  councilSize     Int   @default(3)
  councilReport   Json?
}
```

### BullMQ queue names

- `council-reviewer` — one child job per reviewer workspace
- `council-aggregator` — parent job; runs after all children

### Pipeline position

- Step 9: verifier (currently fire-and-forget after step 8 — made awaitable)
- Step 10: council (`createCouncilStep` using FlowProducer)

### Workspace naming

`hive-council-${taskId.slice(0,8)}-${reviewerIndex}` (e.g. `hive-council-a1b2c3d4-0`)

## Error Handling Strategy

Mirrors verifier failure policy (D007, R032):

- **Council failure is informational** — task stays `done` regardless
- **Partial reviewers complete** — `continueParentOnFailure: true` on reviewer jobs means aggregator runs with partial results
- **All reviewers fail** — `councilReport.outcome = "inconclusive"`, PR comment notes this
- **Invalid JSON from Claude** — reviewer job fails; aggregator proceeds with remaining reviewers
- **PR comment fails** — `postedCommentUrl = null`; `councilReport` still persisted; best-effort only
- **No PR URL on task** — council step is a no-op (guard at entry)
- **Council size = 0** — council step is a no-op
- **Reviewer workspace timeout** — BullMQ 15-min job timeout kills job; `continueParentOnFailure` fires aggregator
- Cleanup: reviewer workspaces in `finally` block (D008 pattern)

## Final Integrated Acceptance

To call this milestone complete, we must prove:

- Submit a task with councilSize=3; observe 3 council-reviewer jobs queued and aggregator in `waiting-children` state in BullMQ
- After reviewers complete, aggregator runs; `task.councilReport` contains all required fields with correct types
- GitHub PR has exactly one new council comment with formatted findings grouped by severity

## Testing Requirements

- **S01:** Unit tests for queue registration. Schema column verification. `terraform validate` for hive-council.
- **S02:** Unit tests for each council blueprint step. Test JSON validation (valid passes, invalid fails job). Test `--print` mode invocation.
- **S03:** Unit tests for aggregation (pure function). Consensus threshold border test (2/3 = consensus, 1/3 = not). PR comment formatting test. Integration test for council step with mock FlowProducer child values.
- **S04:** Component tests for CouncilResultCard. Form field test for councilSize. No E2E.

## Acceptance Criteria

**S01:** `prisma migrate deploy` applies councilSize + councilReport; `terraform validate` passes; BullMQ workers for both queues register and accept test jobs.

**S02:** Council-review step invokes `claude --print` with diff and emits valid JSON; invalid Claude output fails the job; unit tests cover happy path + invalid JSON + empty diff.

**S03:** 2/3 reviewers flagging `{file:"a.ts", startLine:5}` → that finding in `consensusItems` with `count:2`; `gh pr comment` called with correct URL; `councilReport` written with all required fields.

**S04:** CouncilResultCard renders severity counts; council size field saves to DB; task detail shows card after VerificationReportCard.

## Risks and Unknowns

- **Claude CLI JSON reliability** — Claude may not consistently emit valid JSON. Mitigation: strict validation + job failure on invalid output.
- **Consensus grouping precision** — Two reviewers may flag same issue on different lines. File+line grouping may miss some true consensus. Known MVP limitation.
- **FlowProducer integration** — Project currently uses a single Queue + Worker. FlowProducer needs its own instance + second Worker for aggregator queue. IORedis singleton should be reusable.
- **Verifier awaitable change** — Currently fire-and-forget after step 8. Making it awaitable changes pipeline timing; task status transitions need re-testing.

## Existing Codebase / Prior Art

- `src/lib/queue/task-queue.ts` — Add council as step 10; verifier becomes awaitable step 9
- `src/lib/blueprint/verifier.ts` — Blueprint factory pattern to follow for council blueprint
- `src/lib/blueprint/steps/verify-*.ts` — Step factory patterns for council-*.ts steps
- `src/lib/verification/report.ts` — Type shape pattern for `CouncilReport`
- `src/app/tasks/[id]/verification-report-card.tsx` — Component pattern for `CouncilResultCard`
- `templates/hive-worker/main.tf` — Terraform pattern for hive-council template
- `src/lib/workspace/exec.ts` — `execInWorkspace` — reused unchanged
- `src/lib/workspace/cleanup.ts` — `cleanupWorkspace` — reused unchanged
- `src/lib/workspace/naming.ts` — workspace naming conventions

## Relevant Requirements

- R017 — N independent reviewers, findings aggregated by consensus
- R018 — Council size configurable per task (1–7, default 3)
- R019 — Single combined PR comment
- R032 — Council failure is informational
- R033 — Finding schema with issue/fix/reasoning
- R034 — FlowProducer fan-out, runs after verifier

## Scope

### In Scope

- hive-council Coder template (Claude CLI, read-only)
- Council blueprint: council-clone, council-diff, council-review, council-emit steps
- BullMQ FlowProducer fan-out (council-reviewer + council-aggregator queues)
- Aggregation: file+line grouping, ≥2 = consensus
- PR comment via `gh pr comment`
- councilSize + councilReport schema additions
- CouncilResultCard dashboard component
- Council size field on task submission form
- Making verifier awaitable (step 9)

### Out of Scope / Non-Goals

- Inline GitHub review comments (line-level) — top-level only
- Per-repo council size config — task-level only for MVP
- Semantic similarity aggregation — file+line grouping only
- Migrating worker/verifier from Pi to Claude CLI — M002 council only

## Technical Constraints

- Must reuse `getRedisConnection()` IORedis singleton for FlowProducer
- `execInWorkspace` must be used for all remote commands — no direct SSH
- Workspace naming: `hive-council-${taskId.slice(0,8)}-${reviewerIndex}`
- Council step no-op if `task.prUrl` is null
- New types must be clean (no TS errors introduced)

## Integration Points

- Coder API — workspace create/start/stop/delete for council workspaces
- GitHub API (gh CLI) — `gh pr comment` for posting aggregated review
- Claude CLI — `claude --print` for reviewer agent execution
- BullMQ FlowProducer — fan-out/fan-in for parallel reviewer jobs
- Prisma — councilSize + councilReport columns on Task model

## Ecosystem Notes

**BullMQ FlowProducer:** `FlowProducer.add()` atomically adds parent + children jobs. Parent enters `waiting-children` state until all children complete. `job.getChildrenValues()` retrieves all child return values in the parent processor. `continueParentOnFailure: true` lets the parent run even if some children fail.

**GitHub PR commenting:** `gh pr comment <pr-url> --body "..."` posts a top-level PR comment — simpler and more appropriate than `gh pr review --comment` since we're not approving or requesting changes.

**Claude CLI:** `claude --print` runs Claude non-interactively. Context piped via base64-encoded temp file, consistent with the worker agent pattern (D006).

## Open Questions

- None — all questions resolved during discuss phase.
