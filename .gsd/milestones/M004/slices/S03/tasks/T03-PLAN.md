---
estimated_steps: 3
estimated_files: 1
skills_used: []
---

# T03: Add Templates link to dashboard nav and vitest regression

1. Add 'Templates' link to the dashboard navigation (wherever the existing nav is defined)
2. Run full vitest suite — confirm 263+ tests pass
3. Browser verify end-to-end: open /templates, see all 4 templates with stale/current badges, click Push on ai-dev, watch xterm.js terminal render coder output with ANSI colors, confirm badge flips to Current on success

## Inputs

- `src/app/templates/page.tsx`

## Expected Output

- `Updated nav with Templates link`

## Verification

npx vitest run (263+ tests pass)
