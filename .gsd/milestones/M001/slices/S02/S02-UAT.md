---
id: S02
parent: M001
type: artifact-driven
---

# S02: UAT

- `docker exec m001-app-1 wget -qO- http://0.0.0.0:3000/tasks` returns rendered HTML containing task list markup
- `docker exec m001-app-1 wget -qO- http://0.0.0.0:3000/tasks/new` returns rendered HTML containing form elements
- Submit a task via `docker exec m001-app-1 wget --post-data='{"prompt":"test","repoUrl":"https://github.com/test/repo"}' --header='Content-Type: application/json' -qO- http://0.0.0.0:3000/api/tasks` → returns 201 with task JSON including null attachments field
- `vitest run` — all existing + new tests pass
- `__tests__/app/tasks/tasks-pages.test.ts` — unit tests for API route handling of attachments field
