---
estimated_steps: 7
estimated_files: 1
skills_used: []
---

# T03: Unit tests for staleness engine

Create src/__tests__/lib/templates/staleness.test.ts:

1. hashLocalTemplate: same result on two calls (stability)
2. hashRemoteTar: same result on two calls with same buffer
3. stale=true when local and remote hashes differ (mock fetchTemplateFiles to return tar of different content)
4. stale=false when local and remote hashes match (mock to return tar of identical content)
5. compareTemplates: returns array with correct shape, mocking Coder client methods

Mock src/lib/coder/client.ts methods. Use real filesystem for local hash tests against a fixture directory.

## Inputs

- `src/lib/templates/staleness.ts`
- `src/lib/coder/client.ts`

## Expected Output

- `src/__tests__/lib/templates/staleness.test.ts`

## Verification

npx vitest run src/__tests__/lib/templates/staleness.test.ts && npx vitest run
