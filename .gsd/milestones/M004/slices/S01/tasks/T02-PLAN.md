---
estimated_steps: 16
estimated_files: 1
skills_used: []
---

# T02: Implement staleness engine: local hash, remote hash, compareTemplates()

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

## Inputs

- `src/lib/coder/client.ts`

## Expected Output

- `src/lib/templates/staleness.ts`
- `src/lib/templates/index.ts`

## Verification

npx vitest run src/__tests__/lib/templates/staleness.test.ts
