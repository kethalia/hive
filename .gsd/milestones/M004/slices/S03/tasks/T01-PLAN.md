---
estimated_steps: 6
estimated_files: 2
skills_used: []
---

# T01: Server action and data fetching for templates page

Create src/app/templates/actions.ts:
- getTemplateStatuses(): calls compareTemplates() for all 4 known template names, returns TemplateStatus[]
- Server action: revalidates /templates page cache after successful push

Create src/app/api/templates/status/route.ts (GET):
- Returns JSON array of TemplateStatus for all 4 templates
- Used by the frontend to poll staleness every 30s

## Inputs

- `src/lib/templates/staleness.ts`

## Expected Output

- `src/app/templates/actions.ts`
- `src/app/api/templates/status/route.ts`

## Verification

npx vitest run src/__tests__/app/api/templates/status.test.ts
