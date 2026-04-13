# S01: Coder Template API Client & Staleness Engine

**Goal:** Extend Coder API client with template listing and file fetching. Implement deterministic local and remote hashers. Expose compareTemplates() returning per-template stale/current status.
**Demo:** compareTemplates() returns [{name, stale, lastPushed, activeVersionId}] for all 4 templates.

## Must-Haves

- Unit tests pass for hash stability, stale detection, and compareTemplates(). Manual verify against live Coder instance returns correct status for all 4 templates.

## Proof Level

- This slice proves: Not provided.

## Integration Closure

Not provided.

## Verification

- Not provided.

## Tasks

- [x] **T01: Extend Coder client: listTemplates, getActiveVersion, fetchTemplateFiles** `est:30min`
  Add three methods to src/lib/coder/client.ts:
- listTemplates(): fetches GET /api/v2/organizations/default/templates, returns {id, name, activeVersionId, updatedAt}[]
- getActiveVersion(versionId): fetches GET /api/v2/templateversions/:id, returns {id, name, fileId, createdAt, message}
- fetchTemplateFiles(fileId): fetches GET /api/v2/files/:id with application/x-tar content-type, returns Buffer

All use existing CODER_URL / CODER_SESSION_TOKEN env vars.
  - Files: `src/lib/coder/client.ts`
  - Verify: npx vitest run src/__tests__/lib/coder/client.test.ts

- [x] **T02: Implement staleness engine: local hash, remote hash, compareTemplates()** `est:45min`
  Create src/lib/templates/staleness.ts:

1. hashLocalTemplate(name: string): Promise<string>
   - Recursively reads all files under templates/<name>/
   - Sorts paths deterministically
   - Hashes file path + contents with sha256
   - Returns hex digest

2. hashRemoteTar(tarBuffer: Buffer): Promise<string>
   - Parses tar buffer using the 'tar-stream' package
   - Sorts entries deterministically by path
   - Hashes entry path + contents with sha256
   - Returns hex digest

3. compareTemplates(names: string[]): Promise<TemplateStatus[]>
   - For each name: calls listTemplates, getActiveVersion, fetchTemplateFiles
   - Computes local and remote hashes
   - Returns {name, stale, lastPushed, activeVersionId, localHash, remoteHash}[]

Export TemplateStatus type.
  - Files: `src/lib/templates/staleness.ts`
  - Verify: npx vitest run src/__tests__/lib/templates/staleness.test.ts

- [x] **T03: Unit tests for staleness engine** `est:30min`
  Create src/__tests__/lib/templates/staleness.test.ts:

1. hashLocalTemplate: same result on two calls (stability)
2. hashRemoteTar: same result on two calls with same buffer
3. stale=true when local and remote hashes differ (mock fetchTemplateFiles to return tar of different content)
4. stale=false when local and remote hashes match (mock to return tar of identical content)
5. compareTemplates: returns array with correct shape, mocking Coder client methods

Mock src/lib/coder/client.ts methods. Use real filesystem for local hash tests against a fixture directory.
  - Files: `src/__tests__/lib/templates/staleness.test.ts`
  - Verify: npx vitest run src/__tests__/lib/templates/staleness.test.ts && npx vitest run

## Files Likely Touched

- src/lib/coder/client.ts
- src/lib/templates/staleness.ts
- src/__tests__/lib/templates/staleness.test.ts
