# Cloudflare baseline compatibility ledger

The epic must preserve the feature catalog in `docs/features.md`. A successful application build
or login probe does not establish compatibility of the capabilities below. This ledger records
implementation dependencies; actual preview/browser evidence must be added before cutover.

| Capability | Existing dependency | Current epic disposition / next proof |
| --- | --- | --- |
| Login, sessions, settings reads | Auth service, PostgreSQL, Coder HTTP | Real preview login, secure session, API logout and stale-session rejection pass. Settings now uses authenticated typed HTTP reads;46 local tests pass. Built preview Settings-screen logout acceptance remains. |
| Workspace lifecycle and app authorization | Coder HTTP | Eight lifecycle/read actions and four discovery reads pass the committed full-Next local workerd transport proof. Existing authentication/ownership remains; account-backed lifecycle and deployed browser acceptance remain. |
| Project discovery and first task | Installed signed project host | Durable server intents and installed controller implemented; account-backed deployed pilot pending. |
| Conversation and project Terminal | Host native events, tmux PTY, scoped WebSocket | Dedicated relay implemented under review; persistent authorization and browser proof pending. |
| Existing generic terminals, discovery and file links | Coder PTY/proxy, server SSH helper | Signed read service and three portable actions implemented for session lists, file links and tool directories; local boundary/installation tests pass. Generic terminal mutation/relay, live installed reads and browser acceptance remain. |
| Agent tools, integrations and existing conversations | `agents/workspace.ts` SSH + source file | Needs fixed installed helper operations with current Coder ownership/build verification. |
| Terminal uploads and voice | SSH upload, local socket/child process | Needs bounded authenticated host transport; retain MIME/size/path and microphone consent boundaries. |
| Template staleness | Runtime template filesystem + Coder archive | Build manifest and reproducible content-addressed archives implemented; actual local workerd matches all five archives and rejects malformed/unknown inputs. Authenticated Coder download and deployed UI acceptance remain. |
| Template publishing and logs | Redis/BullMQ, local Coder CLI, local log files | Disabled durable existing-template publisher passes real PostgreSQL recovery and actual workerd checks with synthetic provider bindings. Owner/session-bound stages and replayable safe progress implemented. First creation and provisioner-tag parity pass local PostgreSQL/workerd checks; variables remain server-inherited and stdin README behavior matches the CLI. Authenticated bounded log reads and durable completion notices pass local PostgreSQL/workerd and UI checks. An actual inactive artifact import now passes after adding directory headers. Live publication orchestration/push acceptance and activation remain. |
| Notification installation and event delivery | SSH installer + Redis/BullMQ | Delivery reports have durable outbox; existing agent-hook installation/event queue still require adapters. |
| Credential rotation | Redis/BullMQ | Disabled durable auth scheduler and expiry outbox implemented; real PostgreSQL concurrency/recovery, local workerd doubles and migration rehearsal pass. Live provider proof, operator reconciliation and single-scheduler cutover remain. |
| Window layout, navigation and preferences | Browser state + authenticated reads/actions | Existing tests pass; real deployed mobile/desktop acceptance pending. |

Template archive generation rejects symlinks, known private configuration inputs and excessive file
counts/sizes. The committed manifest binds content identity, archive digest and size. Cloudflare
builds verify the manifest before generating static archive assets; source/output readiness also
covers those assets. Template synchronization updates the manifest. No runtime source directory,
shell invocation, or user-provided artifact URL is needed for staleness lookup.

The [local workerd proof](template-comparison-workerd.json) runs the canonical
hashing functions against five real generated archives and a changed archive.
It also checks malformed input, unknown templates and fixture authentication.
Archives came from a clean staged-source export and each metadata entry was
compared with the current manifest. This proves runtime compatibility of the
comparison, not remote Coder download or template publishing. Reproduce with
`node deploy/cloudflare/templates/run-local-comparison.mjs`; an optional
`HIVE_TEMPLATE_PROOF_ROOT` selects a clean source export while active template
work continues, and manifest equality is still required. No deployed Worker,
provider credential or cloud request is used.

Coder's documented template API supports file-backed version import and explicit active-version
updates: https://coder.com/docs/reference/api/templates. This is an implementation direction,
not evidence that the replacement publisher has shipped or been exercised.
