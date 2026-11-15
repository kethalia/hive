# P03 workspace connection bridge and Accounts window

P03 builds on merged P02 `37c55299` through `codex/workspace-accounts-p03`.

## Progress

- [x] P02 production functional acceptance.
- [x] Extract Accounts UI and independent signed transport from the corrected epic.
- [x] Require the selected build before every account operation.
- [x] Package the standalone bridge, pinned Codex runtime installer and native identity helper.
- [x] Initialize the isolated preview database with the existing twelve migrations.
- [x] Publish and validate matching workspace images through the existing workflow.
- [ ] Validate real installed bridge and official provider flows.
- [ ] Validate desktop/mobile Accounts navigation, reload and build changes.
- [ ] Complete review, CI and owner acceptance checklist.

## Visible flow

Open Accounts from Dock Apps, the command palette or Agent Tools. Select a running
workspace and its exact build. Codex and Claude cards display account state and
support connect, cancel, reconnect and disconnect. A workspace rebuild holds
account controls until the current build is explicitly selected.

Codex uses its isolated managed credential directory and the pinned official CLI.
The device-code flow opens the official provider page. Credential storage and
refresh follow the official CLI. [Codex authentication](https://learn.chatgpt.com/docs/auth)

Claude uses the workspace's admitted official CLI. Its browser flow supports a
one-time code entered in the Accounts window. CLI releases 2.1.312 and 2.1.319
have validated executable identities. [Claude authentication](https://code.claude.com/docs/en/authentication),
[CLI reference](https://code.claude.com/docs/en/cli-reference)

## Installed authority

The bridge uses an Ed25519 issuer and fresh owner/workspace/build/agent/template/app
binding. Request and response signatures, package digests, operation allowlists,
credential locks and generation fences govern account changes. The application
resolves the exact build before sending an operation and checks it again afterward.

P03 uses dedicated issuer configuration. Managed task maintenance is tracked in
P05. The preview database contains the existing fifteen application tables and
twelve migrations. The new route composition queries the existing user identity.

Enable the workspace's Hive bridge parameter using a template with the matching
image and package. Template variables carry the deployment origin, public issuer
key and key ID. The private issuer key belongs in the application secret binding.

## Deployment and isolation

The preview uses the existing single Hive Worker and repository-connected Workers
Builds at `https://codex-workspace-accounts-p03.hive-preview.kethalia.com`.
Its database is `hive_workspace_accounts_preview` with runtime role
`hive_accounts_runtime`, on the existing Neon compute. The database receipt records
its identity and canonical migration check.

Workspace image previews use the existing public package and standard GitHub-hosted
runners for this public repository. [Runner billing](https://docs.github.com/en/actions/how-tos/write-workflows/choose-where-workflows-run/choose-the-runner-for-a-job),
[Container registry billing](https://docs.github.com/en/billing/concepts/product-billing/github-packages)

All five workspace profiles pin images built from `78a4401e`. Their publication
receipt records successful CI smoke checks and independent public OCI verification
of the manifest, configuration, native helper and packaged bootstrap bytes.
The isolated test template uses the same CLI image with 4 GiB memory, 10 GiB storage
and an empty repository seed for account validation.

## Validation record

Focused UI, transport, package, native identity and installer checks pass. The
native installer fixture supplies identity/runtime shims. Actual image, installed
vendor CLI and provider acceptance are tracked in the progress checklist.

Production P02 acceptance completed all functional checks. Its harness initially
queried an unavailable standard Better Auth endpoint, then used the application's
user-scoped storage identity. The final run observed three callback responses for
two sign-in POSTs. All observed callbacks returned HTML with status 200 and nosniff.
The production receipt retains those instrumentation limitations.

During local Go compilation, task-created cache data filled the primary home
volume. Those task-created cache entries moved to temporary storage, and the
optional local binary build stopped. Go unit tests completed successfully. Image
CI provides the production-flags helper build.

A search of an older diagnostic JSON file exposed the primary workspace's Coder
session credential in tool output. The session was replaced through Coder's API,
the replacement was verified and stored privately, and the exposed credential was
revoked. A subsequent request using the exposed credential returned 401.
