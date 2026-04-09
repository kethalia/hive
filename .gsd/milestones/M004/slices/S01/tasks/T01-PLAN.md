---
estimated_steps: 5
estimated_files: 1
skills_used: []
---

# T01: Extend Coder client: listTemplates, getActiveVersion, fetchTemplateFiles

Add three methods to src/lib/coder/client.ts:
- listTemplates(): fetches GET /api/v2/organizations/default/templates, returns {id, name, activeVersionId, updatedAt}[]
- getActiveVersion(versionId): fetches GET /api/v2/templateversions/:id, returns {id, name, fileId, createdAt, message}
- fetchTemplateFiles(fileId): fetches GET /api/v2/files/:id with application/x-tar content-type, returns Buffer

All use existing CODER_URL / CODER_SESSION_TOKEN env vars.

## Inputs

- `src/lib/coder/client.ts`

## Expected Output

- `src/lib/coder/client.ts with 3 new methods`

## Verification

npx vitest run src/__tests__/lib/coder/client.test.ts
