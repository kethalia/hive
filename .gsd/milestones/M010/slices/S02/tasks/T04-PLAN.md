---
estimated_steps: 22
estimated_files: 6
skills_used: []
---

# T04: Rewire template operations to per-user credentials and remove static env var requirements

Parameterize template staleness checking and push operations to use per-user credentials instead of env vars. Remove CODER_URL and CODER_SESSION_TOKEN from .env.example. Add ENCRYPTION_KEY. Verify no remaining env var references in src/ (R096).

Steps:
1. In `src/lib/templates/staleness.ts`: change `compareTemplates(names: string[])` signature to `compareTemplates(names: string[], userId: string)`. Replace env var reads with `const client = await getCoderClientForUser(userId)`. Remove the local CoderClient construction from env vars.
2. In `src/lib/templates/push-queue.ts`: add `userId: string` to `TemplatePushJobData` interface. In the worker processor, resolve credentials per-job: `const client = await getCoderClientForUser(job.data.userId)`. Use the decrypted token and user's coderUrl for the child process env instead of `process.env.CODER_URL`/`process.env.CODER_SESSION_TOKEN`.
3. Update callers of `compareTemplates()` to pass userId — search for usage across codebase.
4. Update callers that enqueue template push jobs to include userId in job data.
5. In `src/instrumentation.ts`: verify `createTemplatePushWorker()` still works (it already takes no args, but the internal processor now resolves credentials per-job).
6. In `.env.example`: remove `CODER_URL=` and `CODER_SESSION_TOKEN=` lines. Add `ENCRYPTION_KEY=` with a comment about generating a 32-byte hex key.
7. Run `rg 'CODER_SESSION_TOKEN|CODER_URL' --type ts src/` and verify zero hits outside of test files and type definitions. Fix any remaining references.
8. Write/update tests for staleness.ts and push-queue.ts — mock getCoderClientForUser, verify no env var reads.
9. Run full test suite to verify no regressions from S01 or earlier work.

Must-haves:
- [ ] compareTemplates accepts userId and uses getCoderClientForUser
- [ ] Template push worker resolves per-user credentials per-job
- [ ] TemplatePushJobData includes userId
- [ ] CODER_URL and CODER_SESSION_TOKEN removed from .env.example
- [ ] ENCRYPTION_KEY added to .env.example
- [ ] No CODER_URL/CODER_SESSION_TOKEN references in src/ (excluding tests)
- [ ] Full test suite passes

Negative Tests:
- Template push with userId that has no token → job fails with clear error
- compareTemplates with invalid userId → throws USER_NOT_FOUND

## Inputs

- ``src/lib/coder/user-client.ts` — getCoderClientForUser factory from T01`
- ``src/lib/templates/staleness.ts` — existing compareTemplates with env var reads`
- ``src/lib/templates/push-queue.ts` — existing template push worker with env var reads`
- ``src/instrumentation.ts` — worker bootstrap`
- ``.env.example` — current env var listing`

## Expected Output

- ``src/lib/templates/staleness.ts` — compareTemplates using per-user credentials`
- ``src/lib/templates/push-queue.ts` — template push worker with per-job credential resolution`
- ``src/instrumentation.ts` — updated if needed for new worker signatures`
- ``.env.example` — CODER_URL/CODER_SESSION_TOKEN removed, ENCRYPTION_KEY added`
- ``src/__tests__/templates/staleness.test.ts` — updated tests`
- ``src/__tests__/templates/push-queue.test.ts` — updated tests`

## Verification

pnpm vitest run src/__tests__/templates/ && rg 'CODER_SESSION_TOKEN|CODER_URL' --type ts src/ | grep -v __tests__ | grep -v test; test $? -eq 1
