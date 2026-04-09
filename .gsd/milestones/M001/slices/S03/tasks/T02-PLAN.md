---
estimated_steps: 4
estimated_files: 6
---

# T02: Implement context hydration, scoped rules, and tool selection steps with tests

**Slice:** S03 — Blueprint Execution & Worker Agent
**Milestone:** M001

## Description

Build the three deterministic blueprint steps that run before the agent: context hydration (R027), scoped rule injection (R026), and curated tool selection (R030). These steps use the `execInWorkspace` primitive from T01 to run commands inside the worker workspace, gather information, and populate the `BlueprintContext` for the agent step.

Each step is a `BlueprintStep` (from `src/lib/blueprint/types.ts`): an object with `name` and `execute(ctx)` returning a `StepResult`. Steps mutate the shared `BlueprintContext` to pass data forward (e.g., hydrate populates `ctx.assembledContext`, rules populates `ctx.scopedRules`, tools populates `ctx.toolFlags`).

**Key patterns from prior slices:**
- Mock the module boundary, not the library. For exec, mock `@/lib/workspace/exec` module, not `child_process` directly.
- Return fresh mock values per call using `mockImplementation`, not `mockResolvedValue` (body-read-once issue from S01 knowledge).

## Steps

1. **Create `src/lib/blueprint/steps/hydrate.ts`** — Export a `createHydrateStep(): BlueprintStep` factory. The execute function:
   - Run `find /home/coder/project -type f -name "*.ts" -o -name "*.tsx" -o -name "*.js" -o -name "*.jsx" -o -name "*.py" -o -name "*.go" | head -200` via `execInWorkspace` to get repo file tree
   - Run `cat` via `execInWorkspace` for key files (check existence first with `test -f`): `README.md`, `package.json`, `tsconfig.json`, `AGENTS.md`, `.github/CODEOWNERS`
   - Assemble results into a structured context string: `## Repository Structure\n{tree}\n\n## Key Files\n### README.md\n{content}\n...`
   - Store the assembled string on `ctx.assembledContext`
   - Return `StepResult` with `status: 'success'` and message summarizing file count
   - If the repo directory doesn't exist (find fails), return `status: 'failure'`
   - Use a 30s timeout for each exec call

2. **Create `src/lib/blueprint/steps/rules.ts`** — Export `createRulesStep(): BlueprintStep`. The execute function:
   - Run `find /home/coder/project -name "AGENTS.md" -maxdepth 3` via `execInWorkspace` to locate rule files
   - For each found AGENTS.md, `cat` it via `execInWorkspace`
   - Concatenate all rules with source path headers: `## Rules from /path/to/AGENTS.md\n{content}\n`
   - Store on `ctx.scopedRules`
   - Return `status: 'success'` with count of rule files found
   - If no AGENTS.md files exist, return `status: 'skipped'` (not failure — rules are optional)

3. **Create `src/lib/blueprint/steps/tools.ts`** — Export `createToolsStep(): BlueprintStep`. The execute function:
   - Run `cat /home/coder/project/package.json` via `execInWorkspace` to detect repo type
   - Parse package.json to detect framework: check `dependencies` / `devDependencies` for `next`, `react`, `express`, `fastify`, `playwright`, `cypress`, etc.
   - Base tools always included: `read`, `bash`, `edit`, `write`, `lsp`
   - If web framework detected (next, react, vue, svelte): add `browser` tools
   - If test framework detected (vitest, jest, playwright, cypress): add `test` tool reference
   - Store tool list on `ctx.toolFlags` as string array
   - If package.json doesn't exist (non-Node repo), return base tools with `status: 'success'`
   - Return `status: 'success'` with detected repo type in message

4. **Write tests for all three steps** — Create test files in `src/__tests__/lib/blueprint/steps/`:
   - **hydrate.test.ts**: Mock `@/lib/workspace/exec` module. Tests: (a) successful hydration with realistic find + cat output populates assembledContext, (b) missing repo directory returns failure, (c) missing optional files (no README) still succeeds with partial context, (d) context string contains repo tree and file contents
   - **rules.test.ts**: Mock exec. Tests: (a) finds and concatenates multiple AGENTS.md files, (b) no AGENTS.md files returns skipped, (c) single AGENTS.md at root populates scopedRules
   - **tools.test.ts**: Mock exec. Tests: (a) Next.js project detected → includes browser tools, (b) plain Node.js project → base tools only, (c) no package.json → base tools with success, (d) project with test framework → appropriate tool flags

## Must-Haves

- [ ] Hydrate step fetches repo tree + key files and assembles structured context string (R027)
- [ ] Hydrate step handles missing optional files gracefully (partial context is fine)
- [ ] Rules step finds AGENTS.md at multiple directory depths and concatenates with path headers (R026)
- [ ] Rules step returns 'skipped' (not failure) when no AGENTS.md exists
- [ ] Tools step detects repo type from package.json and selects appropriate tool flags (R030)
- [ ] Tools step works for non-Node repos (returns base tools)
- [ ] All three steps use `execInWorkspace` from `@/lib/workspace/exec` — no direct child_process usage
- [ ] All tests pass: `npx vitest run src/__tests__/lib/blueprint/steps/`

## Verification

- `npx vitest run src/__tests__/lib/blueprint/steps/hydrate.test.ts` — hydrate tests pass
- `npx vitest run src/__tests__/lib/blueprint/steps/rules.test.ts` — rules tests pass
- `npx vitest run src/__tests__/lib/blueprint/steps/tools.test.ts` — tools tests pass
- `npx vitest run` — no existing tests broken

## Inputs

- `src/lib/workspace/exec.ts` — the `execInWorkspace` function from T01
- `src/lib/blueprint/types.ts` — `BlueprintStep`, `BlueprintContext`, `StepResult` types from T01
- Knowledge: workspace project is cloned to `/home/coder/project` (from `templates/hive-worker/scripts/init.sh`)
- Knowledge: `AGENTS.md` is the standard rule file name in GSD convention

## Expected Output

- `src/lib/blueprint/steps/hydrate.ts` — context hydration step (R027)
- `src/lib/blueprint/steps/rules.ts` — scoped rule injection step (R026)
- `src/lib/blueprint/steps/tools.ts` — curated tool selection step (R030)
- `src/__tests__/lib/blueprint/steps/hydrate.test.ts` — 3-4 test cases
- `src/__tests__/lib/blueprint/steps/rules.test.ts` — 3 test cases
- `src/__tests__/lib/blueprint/steps/tools.test.ts` — 3-4 test cases
