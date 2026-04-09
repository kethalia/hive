---
estimated_steps: 11
estimated_files: 2
skills_used: []
---

# T01: Template push queue, worker, and job processor

Create src/lib/templates/push-queue.ts:
- Define templatePushQueue (BullMQ Queue) and templatePushWorker (BullMQ Worker)
- Job data: { templateName: string, jobId: string }
- Processor:
  1. Resolves path to coder CLI binary (which coder or fallback)
  2. Spawns child process: coder templates push <name> --directory templates/<name> --yes
  3. Injects CODER_URL and CODER_SESSION_TOKEN from process.env into child env
  4. Tees stdout+stderr to /tmp/template-push-<jobId>.log (append mode)
  5. Writes final exit line '\n[exit: 0]\n' or '\n[exit: 1]\n' to log on close
  6. Resolves on exit 0, rejects on non-zero exit
- Register worker in src/lib/queue/index.ts alongside existing workers

## Inputs

- `src/lib/templates/staleness.ts`
- `src/lib/queue/index.ts`

## Expected Output

- `src/lib/templates/push-queue.ts`

## Verification

npx vitest run src/__tests__/lib/templates/push-queue.test.ts
