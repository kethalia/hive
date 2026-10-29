# Cloudflare baseline compatibility ledger

The epic must preserve the feature catalog in `docs/features.md`. A successful application build
or login probe does not establish compatibility of the capabilities below. This ledger records
implementation dependencies; actual preview/browser evidence must be added before cutover.

| Capability | Existing dependency | Current epic disposition / next proof |
| --- | --- | --- |
| Login, sessions, settings reads | Auth service, PostgreSQL, Coder HTTP | Real preview login, secure session, API logout and stale-session rejection pass. Settings now uses authenticated typed HTTP reads;46 local tests pass. Built preview Settings-screen logout acceptance remains. |
| Workspace lifecycle and app authorization | Coder HTTP | REST client is portable; preview still blocks server actions until each callable capability is classified. |
| Project discovery and first task | Installed signed project host | Durable server intents and installed controller implemented; account-backed deployed pilot pending. |
| Conversation and project Terminal | Host native events, tmux PTY, scoped WebSocket | Dedicated relay implemented under review; persistent authorization and browser proof pending. |
| Existing generic terminals, discovery and file links | Coder PTY/proxy, server SSH helper | Needs bounded installed operations and authorized relay; project-terminal proof does not cover this surface. |
| Agent tools, integrations and existing conversations | `agents/workspace.ts` SSH + source file | Needs fixed installed helper operations with current Coder ownership/build verification. |
| Terminal uploads and voice | SSH upload, local socket/child process | Needs bounded authenticated host transport; retain MIME/size/path and microphone consent boundaries. |
| Template staleness | Runtime template filesystem + Coder archive | Build manifest and reproducible content-addressed archives implemented; actual workerd archive comparison pending. |
| Template publishing and logs | Redis/BullMQ, local Coder CLI, local log files | Replace with durable jobs using Coder file/template-version APIs and bounded replayable logs; preserve current activation semantics and owner checks. |
| Notification installation and event delivery | SSH installer + Redis/BullMQ | Delivery reports have durable outbox; existing agent-hook installation/event queue still require adapters. |
| Credential rotation | Redis/BullMQ | Provenance checks implemented; bounded durable scheduler pending. |
| Window layout, navigation and preferences | Browser state + authenticated reads/actions | Existing tests pass; real deployed mobile/desktop acceptance pending. |

Template archive generation rejects symlinks, known private configuration inputs and excessive file
counts/sizes. The committed manifest binds content identity, archive digest and size. Cloudflare
builds verify the manifest before generating static archive assets; source/output readiness also
covers those assets. Template synchronization updates the manifest. No runtime source directory,
shell invocation, or user-provided artifact URL is needed for staleness lookup.

Coder's documented template API supports file-backed version import and explicit active-version
updates: https://coder.com/docs/reference/api/templates. This is an implementation direction,
not evidence that the replacement publisher has shipped or been exercised.
