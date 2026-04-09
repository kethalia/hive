---
id: S01
parent: M001
type: artifact-driven
---

# S01: UAT

- `npm test` — all unit/integration tests pass:
  - `__tests__/lib/coder/client.test.ts` — Coder client with mocked fetch (create, get, delete, polling)
  - `__tests__/lib/queue/worker.test.ts` — BullMQ queue add + worker dispatch
  - `__tests__/lib/api/tasks.test.ts` — createTask persists to DB + enqueues job, getTask/listTasks return data
- `docker-compose up -d && curl -s http://localhost:3000` returns HTML (Next.js running)
- `docker-compose exec postgres psql -U hive -d hive -c '\dt'` shows tasks, task_logs, workspaces tables
- `hive-worker/main.tf` contains `variable "task_id"`, `variable "task_prompt"`, `variable "repo_url"`, `variable "branch_name"` blocks
