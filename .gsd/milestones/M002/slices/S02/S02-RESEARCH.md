# S02 Research: Review Blueprint & Claude Integration

**Slice goal:** Implement the council reviewer blueprint steps and wire them into the council-reviewer BullMQ worker so that a reviewer job clones the PR branch, gets the diff, invokes `claude --print` with a structured prompt, parses the JSON output as `ReviewerFinding[]`, and returns it as the job value.

**Depth:** Targeted — the blueprint step factory pattern is fully established in this codebase; council just needs Claude instead of Pi, and a JSON-parse step instead of a verification-strategy dispatch.

---

## Summary

S02 is well-bounded: create four council blueprint steps following the exact same factory pattern as the verifier steps, then swap the skeleton worker processor in `council-queues.ts` for a real blueprint runner. No new patterns, no new libraries. The only genuine risk is Claude CLI's JSON reliability — mitigated by the already-decided strict validation policy (D012: invalid JSON → job failure, not empty findings).

**Requirements owned by S02:**
- **R017** — N independent reviewers run in parallel; S02 provides the per-reviewer execution logic (the N-parallel part is the FlowProducer fan-out in task-queue, done in S03; S02 delivers the single-reviewer logic)
- **R033** — `{ findings: [{ file, startLine, severity, issue, fix, reasoning }] }` schema with strict JSON validation; invalid JSON fails the job

---

## Implementation Landscape

### Pattern to Follow: Verifier Blueprint Steps

Each council step is a factory `createCouncilXStep(): BlueprintStep` — identical shape to `createVerifyCloneStep` etc. All steps:
- Import `execInWorkspace` from `@/lib/workspace/exec`
- Return `{ name, execute(ctx) }` where `execute` returns `{ status, message, durationMs }`
- Use base64 encoding for any user-controlled strings piped to shell
- Never throw — always return a StepResult

The runner (`src/lib/blueprint/runner.ts`) stops at first failure, so steps can rely on previous steps having succeeded.

### Four Council Blueprint Steps

**1. `council-clone` (`src/lib/blueprint/steps/council-clone.ts`)**

Same logic as `verify-clone.ts` — clone repo + checkout PR branch. Can literally copy the pattern with `ctx.workspaceName`, `ctx.repoUrl`, `ctx.branchName`. Uses the same `PROJECT_DIR` constant and idempotent clone/fetch pattern.

**2. `council-diff` (`src/lib/blueprint/steps/council-diff.ts`)**

Get the PR diff from the workspace. The PR branch is already checked out. Command:
```bash
cd /home/coder/project && git diff origin/main...HEAD
```
(Or `git diff HEAD~1..HEAD` if `origin/main` isn't available — but the verifier pattern uses origin fetch, so the remote is available.) Store diff in `ctx` for the review step. Since `BlueprintContext` doesn't have a diff field yet, we need to extend it or use a side-channel.

**Context extension approach:** Add optional `councilDiff?: string` and `councilFindings?: string` fields to `BlueprintContext` in `types.ts`, following the pattern of `verificationStrategy?: VerificationStrategy` and `verificationReport?: string`. These are safe to add as optional fields without breaking existing steps.

**Empty diff handling:** If the diff is empty (e.g. initial commit), return `{ status: "success", message: "empty diff — no findings", durationMs }` with `ctx.councilDiff = ""`. The review step will skip invocation and write empty findings. This is the "graceful empty diff" case required by S02's success criteria.

**3. `council-review` (`src/lib/blueprint/steps/council-review.ts`)**

This is the Claude CLI invocation. The pattern follows `agent.ts` but simpler:

1. Write the prompt to a temp file via base64 (`/tmp/hive-council-prompt.txt`). The prompt includes the diff inline.
2. Run `claude --print` with the prompt file. Use `AGENT_TIMEOUT_MS` (30 min) — same as agent step.
3. Store raw stdout on `ctx.councilFindings` for the parse step.

The prompt must instruct Claude to output **only** valid JSON matching `{ findings: ReviewerFinding[] }`. The prompt is assembled in the step from the diff (already on `ctx.councilDiff`) plus the finding schema.

Empty diff path: if `ctx.councilDiff === ""`, return `{ status: "success", message: "empty diff — skipping review" }` and set `ctx.councilFindings = JSON.stringify({ findings: [] })`.

Claude CLI invocation:
```bash
claude --print "$(cat /tmp/hive-council-prompt.txt)"
```
No `--tool` flags needed — council workspace is read-only review, no code execution. No `--no-session` flag documented; `--print` is the non-interactive mode flag (D010 confirmed).

**4. `council-emit` (`src/lib/blueprint/steps/council-emit.ts`)**

Parses `ctx.councilFindings` as `{ findings: ReviewerFinding[] }` and validates each finding against the schema. Returns the parsed array as the step result message (serialised to JSON). The actual return value for the BullMQ job comes from the worker processor.

If JSON parse fails: `return { status: "failure", message: "Invalid JSON from Claude: ..." }` — this causes the reviewer job to fail, which is the intended behavior per D012.
If JSON is valid but `findings` is missing/wrong shape: same failure.
If valid: `return { status: "success", message: JSON.stringify(findings) }`.

### Council Reviewer Blueprint Factory

```typescript
// src/lib/blueprint/council-reviewer.ts
export function createCouncilReviewerBlueprint(): BlueprintStep[] {
  return [
    createCouncilCloneStep(),
    createCouncilDiffStep(),
    createCouncilReviewStep(),
    createCouncilEmitStep(),
  ]
}
```

### Wiring into council-queues.ts Worker

The `createCouncilReviewerWorker` in `council-queues.ts` currently has a skeleton processor. S02 replaces it with real logic:

```typescript
async (job) => {
  const { taskId, reviewerIndex, repoUrl, branchName } = job.data;
  const workspaceName = councilWorkspaceName(taskId, reviewerIndex);
  // ... create/wait for workspace (via CoderClient) ...
  const ctx: CouncilBlueprintContext = { ... }
  const steps = createCouncilReviewerBlueprint();
  const result = await runBlueprint(steps, ctx);
  if (!result.success) throw new Error(...)
  // parse findings from ctx and return as job value
  return parsedFindings; // ReviewerFinding[]
}
```

**Critical:** The reviewer worker needs a `CoderClient` — same pattern as `createTaskWorker(coderClient)`. The factory signature must change to `createCouncilReviewerWorker(coderClient: CoderClient)`.

**Context shape for council:** The council blueprint steps use a subset of `BlueprintContext`. The cleanest approach is to extend `BlueprintContext` with `councilDiff?: string` and `councilFindings?: string`, and use `BlueprintContext` as-is (with council-unused fields set to empty strings). This avoids creating a second context type. The `piProvider`/`piModel` fields can be set to empty strings since council uses `claude --print` directly.

### Constants Needed

Add to `src/lib/constants.ts`:
- `COUNCIL_CONTEXT_FILE = "/tmp/hive-council-prompt.txt"` — temp file for council prompt
- `COUNCIL_DIFF_FILE = "/tmp/hive-council-diff.txt"` — optional, could also pass inline

### Task-Queue Integration (not S02 scope, but S02 must not break it)

S02's deliverable is the reviewer worker logic. The actual `createCouncilStep` that calls `FlowProducer.add()` and creates workspaces for each reviewer is **S03 scope** (S03 has FlowProducer fan-out in its description). S02 focuses on what happens *inside* a single reviewer job.

However — the `createCouncilReviewerWorker` factory signature changes (adding `coderClient` param). This means the worker startup code (wherever `createCouncilReviewerWorker()` is called) will need updating. Based on the codebase, the workers are started in the app startup — but `createCouncilReviewerWorker` isn't wired yet. S02 should add the coderClient param to the factory and update the test accordingly; S03 will actually wire workspace creation for council into the pipeline.

**Wait — re-reading the S01 summary:** The S01 worker is a skeleton that just logs. S02's goal (per the roadmap) is to make "unit tests show council blueprint steps execute correctly — claude --print invoked with diff, valid JSON returned." This means S02 should implement the blueprint steps themselves and their unit tests. The full integration of workspace creation in the worker can be done minimally in S02 or deferred to S03. Given S02's success criteria says "unit tests show council blueprint steps execute correctly", the safest split is:

- **S02 delivers:** blueprint step implementations + their unit tests
- **S03 delivers:** the full worker processor with workspace creation + FlowProducer fan-out

This means the worker in `council-queues.ts` can remain a skeleton in S02, and S02 just wires up the blueprint steps.

### Files to Create

1. `src/lib/blueprint/steps/council-clone.ts`
2. `src/lib/blueprint/steps/council-diff.ts`
3. `src/lib/blueprint/steps/council-review.ts`
4. `src/lib/blueprint/steps/council-emit.ts`
5. `src/lib/blueprint/council-reviewer.ts`
6. `src/__tests__/lib/blueprint/steps/council-clone.test.ts`
7. `src/__tests__/lib/blueprint/steps/council-diff.test.ts`
8. `src/__tests__/lib/blueprint/steps/council-review.test.ts`
9. `src/__tests__/lib/blueprint/steps/council-emit.test.ts`

### Files to Modify

1. `src/lib/blueprint/types.ts` — add `councilDiff?: string` and `councilFindings?: string` to `BlueprintContext`
2. `src/lib/constants.ts` — add `COUNCIL_CONTEXT_FILE` constant (temp file path for prompt)

### Test Patterns

Follow `verify-clone.test.ts` / `verify-report.test.ts` / `agent.test.ts` exactly:

```typescript
vi.mock("@/lib/workspace/exec", () => ({ execInWorkspace: vi.fn() }))
import { execInWorkspace } from "@/lib/workspace/exec"
const mockExec = vi.mocked(execInWorkspace)
```

Test cases required per S02 success criteria:
- **council-clone:** success, failure paths (same as verify-clone)
- **council-diff:** success with diff content, success with empty diff, failure on git error
- **council-review:** 
  - happy path: `claude --print` returns valid JSON `{ findings: [...] }`  
  - empty diff skips invocation, returns empty findings  
  - claude exits non-zero → step failure
- **council-emit:**
  - valid JSON with correct schema → success, `ctx.councilFindings` parsed correctly
  - invalid JSON string → `status: "failure"` (the key R033 requirement)
  - valid JSON but wrong shape (no `findings` field) → `status: "failure"`
  - empty findings array → `status: "success"` with empty array

### Claude --print Invocation Pattern

From the agent step analysis and D010, the claude invocation should be:
```bash
claude --print "$(cat /tmp/hive-council-prompt.txt)"
```
With `ANTHROPIC_API_KEY` already set in the workspace environment by Terraform (the `coder_agent` env block injects it). No extra env var export needed in the step.

The prompt needs to enforce JSON-only output. Something like:
```
You are a code reviewer. Analyse the following git diff and output ONLY valid JSON with this exact schema:
{"findings": [{"file": string, "startLine": number, "severity": "critical"|"major"|"minor"|"nit", "issue": string, "fix": string, "reasoning": string}]}
Output nothing else — no explanations, no markdown, just the JSON object.

<diff>
{{DIFF}}
</diff>
```

The diff is written to a temp file first (to avoid shell quoting issues with large diffs), and the prompt is also written to a temp file — following the same base64 pattern as agent.ts.

### Key Constraints

- `execInWorkspace` never throws — always check `exitCode !== 0`
- All user-controlled strings (repoUrl, branchName, diff content) must be base64-encoded before shell interpolation
- The diff from git could be very large — write it to a temp file rather than inline in the prompt
- Step names must be kebab-case strings matching the file names: `"council-clone"`, `"council-diff"`, `"council-review"`, `"council-emit"`

---

## Recommendation

**This is straightforward application of established patterns. No novel architecture needed.**

1. Extend `BlueprintContext` with `councilDiff?` and `councilFindings?` optional fields
2. Add `COUNCIL_CONTEXT_FILE` constant
3. Create four steps following `verify-clone.ts` / `agent.ts` patterns
4. Create `council-reviewer.ts` blueprint factory
5. Write unit tests for each step (~8–12 tests total)
6. All four steps tested with `execInWorkspace` mocked

The only non-obvious thing is how to pass the diff into the Claude prompt without shell injection — use the base64 + temp file pattern already established in `agent.ts`.

The S02/S03 boundary should be: **S02 = blueprint steps + tests**; **S03 = worker processor with workspace creation + FlowProducer fan-out + aggregation**. This matches the roadmap's described S02 success criteria ("unit tests show council blueprint steps execute correctly").

---

## Forward Intelligence for Planner

- **`BlueprintContext` extension is safe** — all new fields are optional; existing steps ignore unknown context fields
- **`council-review` test must mock both the prompt-write exec call AND the `claude --print` exec call** — look at how `agent.test.ts` mocks the two sequential write calls before the pi invocation
- **Empty diff edge case** — the "empty diff produces empty findings gracefully" criterion means `council-diff` must NOT return failure on empty diff; it should set `ctx.councilDiff = ""` and return success, then `council-review` guards on empty diff before invoking Claude
- **`council-emit` is the critical JSON validation gate** — this is where R033 is enforced; the test that exercises "invalid JSON fails the job" is the most important test in S02
- **No need to pass ANTHROPIC_API_KEY in the step** — it's injected by Terraform into the workspace agent environment; the `execInWorkspace` bash login shell (`bash -l -c`) will have it in the environment
- **Step return value vs worker return value** — `council-emit` returns the findings as a JSON string in `StepResult.message`. The actual BullMQ job return value (what the aggregator's `job.getChildrenValues()` will see) must be the parsed `ReviewerFinding[]`. Since the worker processor is out of scope for S02, the blueprint just needs to put the data on `ctx.councilFindings` for the S03 worker to read.
- **The `piProvider`/`piModel` fields in BlueprintContext** — set them to empty strings `""` in the council context; the council steps don't use them. No need to validate them (council-review uses `claude --print` directly, not the pi provider system)
