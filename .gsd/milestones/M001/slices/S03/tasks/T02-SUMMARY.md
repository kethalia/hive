---
id: T02
parent: S03
milestone: M001
provides:
  - createHydrateStep for context hydration (R027) — fetches repo tree + key files into assembledContext
  - createRulesStep for scoped rule injection (R026) — finds AGENTS.md files into scopedRules
  - createToolsStep for curated tool selection (R030) — detects repo type into toolFlags
key_files:
  - src/lib/blueprint/steps/hydrate.ts
  - src/lib/blueprint/steps/rules.ts
  - src/lib/blueprint/steps/tools.ts
  - src/__tests__/lib/blueprint/steps/hydrate.test.ts
  - src/__tests__/lib/blueprint/steps/rules.test.ts
  - src/__tests__/lib/blueprint/steps/tools.test.ts
key_decisions:
  - Key files list is fixed (README.md, package.json, tsconfig.json, AGENTS.md, .github/CODEOWNERS) — checked with test -f before cat
  - Rules step returns 'skipped' not 'failure' when no AGENTS.md exists — rules are optional
  - Tool detection uses exact dependency name matching (not substring) against known framework lists
  - Non-Node repos get base tools (read, bash, edit, write, lsp) with success status, not failure
patterns_established:
  - "[blueprint] step-name:" prefixed logs for step-specific context (file counts, detected types, tool lists)
  - Steps mock @/lib/workspace/exec module boundary, dispatch on cmd string content in mockImplementation
  - All steps use 30s timeout for exec calls (vs 60s default) since they run simple commands
observability_surfaces:
  - "[blueprint] hydrate-context:" log with tree file count and key file count
  - "[blueprint] scoped-rules:" log with rule file count or "no AGENTS.md found"
  - "[blueprint] tool-selection:" log with detected type and tool list
  - ctx.assembledContext, ctx.scopedRules, ctx.toolFlags populated after respective steps
duration: 6m
verification_result: passed
completed_at: 2026-03-19
blocker_discovered: false
---

# T02: Implement context hydration, scoped rules, and tool selection steps with tests

**Added three deterministic blueprint steps (hydrate, rules, tools) that populate BlueprintContext before agent execution, with 11 passing tests**

## What Happened

Created three `BlueprintStep` factory functions in `src/lib/blueprint/steps/`:

1. **`hydrate.ts`** — `createHydrateStep()` runs `find` to get repo file tree (up to 200 files), then checks and reads key files (README.md, package.json, tsconfig.json, AGENTS.md, .github/CODEOWNERS) via `execInWorkspace`. Assembles a structured markdown string with `## Repository Structure` and `## Key Files` sections. Missing optional files are silently skipped; missing repo directory returns failure.

2. **`rules.ts`** — `createRulesStep()` finds all `AGENTS.md` files up to depth 3, reads each one, and concatenates with `## Rules from {path}` headers. Returns `skipped` (not failure) when no rule files exist since they're optional.

3. **`tools.ts`** — `createToolsStep()` reads `package.json`, parses dependencies to detect web frameworks (next, react, vue, svelte, etc.) and test frameworks (vitest, jest, playwright, etc.), then builds a tool list starting from base tools (read, bash, edit, write, lsp) and adding `browser`/`test` as warranted. Non-Node repos get base tools with success status.

All three steps use 30s timeout for exec calls and follow the `[blueprint]` log prefix convention.

## Verification

- `npx vitest run src/__tests__/lib/blueprint/steps/hydrate.test.ts` — 4 tests pass
- `npx vitest run src/__tests__/lib/blueprint/steps/rules.test.ts` — 3 tests pass
- `npx vitest run src/__tests__/lib/blueprint/steps/tools.test.ts` — 4 tests pass
- `npx vitest run` — all 47 tests pass (10 files), zero regressions

## Verification Evidence

| # | Command | Exit Code | Verdict | Duration |
|---|---------|-----------|---------|----------|
| 1 | `npx vitest run src/__tests__/lib/blueprint/steps/hydrate.test.ts` | 0 | ✅ pass | 0.2s |
| 2 | `npx vitest run src/__tests__/lib/blueprint/steps/rules.test.ts` | 0 | ✅ pass | 0.2s |
| 3 | `npx vitest run src/__tests__/lib/blueprint/steps/tools.test.ts` | 0 | ✅ pass | 0.2s |
| 4 | `npx vitest run src/__tests__/lib/blueprint/steps/` | 0 | ✅ pass | 3.5s |
| 5 | `npx vitest run` | 0 | ✅ pass | 2.9s |

## Diagnostics

- Grep logs for `[blueprint] hydrate-context:` to see tree file and key file counts per task
- Grep logs for `[blueprint] scoped-rules:` to see rule file discovery results
- Grep logs for `[blueprint] tool-selection:` to see detected repo type and selected tools
- After steps run, inspect `ctx.assembledContext` for the full context string, `ctx.scopedRules` for concatenated rules, `ctx.toolFlags` for the tool list
- Failed hydration includes stderr snippet in the failure message; missing package.json is a known-good path (base tools returned)

## Deviations

None.

## Known Issues

None.

## Files Created/Modified

- `src/lib/blueprint/steps/hydrate.ts` — Context hydration step: fetches repo tree + key files into ctx.assembledContext
- `src/lib/blueprint/steps/rules.ts` — Scoped rules step: finds AGENTS.md files into ctx.scopedRules
- `src/lib/blueprint/steps/tools.ts` — Tool selection step: detects repo type into ctx.toolFlags
- `src/__tests__/lib/blueprint/steps/hydrate.test.ts` — 4 test cases for hydration (success, failure, partial, content verification)
- `src/__tests__/lib/blueprint/steps/rules.test.ts` — 3 test cases for rules (multiple files, no files, single file)
- `src/__tests__/lib/blueprint/steps/tools.test.ts` — 4 test cases for tools (Next.js, plain Node, no package.json, test framework)
