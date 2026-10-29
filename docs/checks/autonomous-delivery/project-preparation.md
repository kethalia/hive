# Durable project preparation and two-view integration

2026-10-29. Implementation under the epic; not production acceptance.

Selecting a GitHub repository resolves its stable repository/account identity through the
workspace's fixed authenticated helper. The controller atomically enrolls the owner-scoped
project, then asks the verified host to enroll that same project ID. No checkout, native thread
or inference is created by selection. A rename updates verified display metadata without changing
project identity. Browser-supplied names, clone URLs, shell paths and runtime settings are rejected.

Submitting a task validates current write access, repository status and the selected source SHA.
The server supplies its configured manager model/effort. A deterministic UUID identifies the
owner/project/original request; a separate SHA-256 digest binds the accepted request body. A retry
of an accepted request returns its durable state even if the default branch subsequently advances.
A changed body under the same request ID conflicts rather than silently replacing work.

The controller persists a `ProjectTaskIntent` before reporting acceptance. Its host request,
including the prompt, uses the existing authenticated encryption primitive and binds the decrypted
payload to the owner, project, workspace, task, request and digest. Prompts are not plaintext audit
fields. Payload ciphertext is removed once the host reports the native task running; blocked work
is retained for investigation. The host separately journals preparation and first-prompt intent.
Neither a transport timeout nor a browser disconnect proves the native operation did not happen.

A scheduled controller reconciles the queue without a browser. A status request may accelerate
one claim, but uses the same database lease and host idempotency identity. Claims use the database
clock, row locking and `SKIP LOCKED`; acknowledgements require the current unexpired lease UUID.
A crashed/expired worker cannot overwrite its replacement. Five failures or abandoned leases
block automatic retries. Thirty minutes without a changed preparation status also blocks work;
unchanged successful polling does not reset that deadline. Running native tasks are excluded from
this preparation deadline and periodically reconcile registration after a host restart without
resubmitting the erased prompt. Each invocation processes at most three claims; request-local database
resources remain alive until independent notice and preparation dispatches settle. Production
cron remains empty and `HIVE_PROJECT_TASKS_ENABLED` defaults false.

Queued work submits the exact encrypted host request. Prepared work independently revalidates
Coder ownership/build/app and provisions the host's selected active projects. Only after durable
registration may the installed host submit the journaled real first prompt. No dummy prompt is
used to manufacture a persistent native session. The browser can reconnect to its existing task
through the host's current task ID rather than creating another intent.

The project panel mounts one read adapter for Conversation. Switching views neither creates nor
resumes an agent. Terminal loads only after explicit selection, then remains attached while hidden;
its separate short-lived capability attaches only the existing private tmux session. The two view
clients have separate transports and capabilities but share the registered native thread. A
same-origin Worker relay is required for the workers.dev preview because Coder's app cookie is
SameSite=Lax. The relay and actual browser acceptance remain separate gates from these UI tests.

## Evidence and remaining gates

- Seven actual local PostgreSQL tests cover concurrent enqueue, encrypted payload, owner/workspace
  isolation, competing claims, stale acknowledgement, process/browser-loss recovery, bounded failure
  and crashed-lease exhaustion, ciphertext substitution and partial encrypted-column rejection.
- Controller checks cover source/access changes, server-owned runtime settings, bounded prompt
  input, exact response identities and registration membership; UI checks cover no execution on
  selection, same-ID submission retry, existing-task recovery and terminal visibility lifetime.
- These controller and UI tests use fixtures. Installed full host composition, deployed Worker
  scheduling, account-backed inference, terminal/browser interaction and a complete delivery pilot
  remain unverified. No production behavior or cleanup authority is activated by this slice.
- Preparation intent IDs and manager-planned task/epic IDs are distinct. Their trusted checkout
  context mapping, observed subagent execution, authoritative evidence and release adapters must
  be completed before enabling managed autonomous delivery. Prompt instructions alone do not
  establish this mapping or prove that tests/reviews passed.
- Blocked preparation retains its session/work and stops automatic retries. User recovery controls,
  unattended preparation-failure notices and a long-task lease-renewal proof are outstanding gates.
