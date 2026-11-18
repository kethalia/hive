# P03 workspace connection bridge and provider account windows

P03 builds on merged P02 `37c55299` through `codex/workspace-accounts-p03`.

## Progress

- [x] P02 production functional acceptance.
- [x] Extract Accounts UI and independent signed transport from the corrected epic.
- [x] Require the selected build before every account operation.
- [x] Package the standalone bridge, pinned Codex runtime installer and native identity helper.
- [x] Initialize the isolated preview database with the existing twelve migrations.
- [x] Publish and validate matching workspace images through the existing workflow.
- [x] Rebuild the five workspace images for Claude 2.1.325 admission.
- [x] Validate the installed bridge, official sign-in prompts and cancellation for both providers.
- [x] Deploy the isolated P03 preview through the existing Workers Builds connection.
- [x] Verify normal hosted Coder OAuth and persisted credential readback.
- [x] Prepare the production bridge issuer secret and public enrollment settings.
- [x] Complete genuine Codex consent, reload persistence and reconnect.
- [x] Verify native Codex usage/settings reads, save, reload and original-value restoration.
- [x] Verify Claude official prompts, cancellation and retry.
- [x] Validate Creative Studio connection parity and Codex usage/settings through the hosted preview.
- [x] Validate desktop/mobile Accounts navigation, reload and build changes.
- [x] Complete independent implementation review and local validation.
- [ ] Owner review, merge and production release activation.

## Visible flow

Open Codex account or Claude account from the command palette or Agent Tools. Each
opens a separate window. Older Accounts links and saved windows open Codex with
the original selection. Select a running
workspace and its exact build. Codex and Claude cards display connection feedback and support official sign-in,
absolute expiry countdown, cancellation, reconnect and confirmed disconnect.
Codex supports copying its device code and displays verified account metadata when
the native runtime supplies it. A workspace rebuild holds
account controls until the current build is explicitly selected.

The signed-in Codex card also contains Usage and Runtime settings. Native usage
reports include supported limits, credits and token summaries. Settings cover the
model, review model, reasoning effort, response detail, web search and service
tier, with source/version feedback and native configuration precedence. Saves
carry the current account generation and native config version. An uncertain
write requires readback before another save.

Codex uses its isolated managed credential directory and the pinned official CLI.
The device-code flow opens the official provider page. Credential storage and
refresh follow the official CLI. [Codex authentication](https://learn.chatgpt.com/docs/auth)

Claude uses the workspace's admitted official CLI. Its browser flow supports a
one-time code entered in the Claude window. CLI releases 2.1.312, 2.1.319,
2.1.325 and 2.1.326 have validated executable identities. The installed 2.1.325 release passed
status, login-prompt and cancellation checks using temporary HOME/config directories.
The signed-manifest, executable and protocol evidence is recorded in
[the 2.1.325 admission receipt](claude-2.1.325-admission.json).
The startup updater selected 2.1.326 during resumed acceptance. Its signed vendor
manifest, exact installed binary and isolated login/status/cancel protocol passed
verification before admission. [The 2.1.326 receipt](claude-2.1.326-admission.json). [Claude authentication](https://code.claude.com/docs/en/authentication),
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
The public template variables and workspace parameter are recorded in
[workspace-enrollment.json](workspace-enrollment.json). After the owner merges
P03, publish the matching template with its production variables, enable Hive
agent tools for the selected workspace and rebuild it.

## Deployment and isolation

The preview uses the existing single Hive Worker and repository-connected Workers
Builds at `https://codex-workspace-accounts-p03.hive-preview.kethalia.com`.
Its database is `hive_workspace_accounts_preview` with runtime role
`hive_accounts_runtime`, on the existing Neon compute. The database receipt records
its identity and canonical migration check.

Workspace image previews use the existing public package and standard GitHub-hosted
runners for this public repository. [Runner billing](https://docs.github.com/en/actions/how-tos/write-workflows/choose-where-workflows-run/choose-the-runner-for-a-job),
[Container registry billing](https://docs.github.com/en/billing/concepts/product-billing/github-packages)

The initial P03 image receipt records source `194122f1`. The resumed connection
work adds Codex management and complete Claude terminal-link parsing. Its current
image references and independent OCI/bootstrap verification are recorded in the
[connection parity publication receipt](connection-parity-images.json).
[Initial P03 publication receipt](image-publications.json),
[earlier 78a4401 publication receipt](image-publications-78a4401.json).
The isolated test template uses the same CLI image with 4 GiB memory, 10 GiB storage
and an empty repository seed for account validation.
The existing remote Builds configuration had a branch allowlist that skipped P03
while reporting success. Its preview commands now use the repository profile
configuration. CI branches without a profile receive an explicit skip. Manual
preview deployment still requires a reviewed profile. The enrollment receipt
records the connected build and accessible deployment.
[Preview enrollment receipt](preview-build-enrollment.json)

## Cold first-use startup

The first workspace build ran the vendor Codex validation script before Hive's
AI Tools startup had installed the ordinary CLI. The vendor check failed while
AI Tools completed successfully 19.246 seconds later. Removing the redundant
Codex module gives CLI installation to Hive's existing startup script and uses
the explicit native launcher. The removal also ends the vendor module's startup
login from an ambient `OPENAI_API_KEY` and its shell-profile PATH additions.
The finding receipt records the source comparison and isolated cold/existing-CLI
reproduction. The real Coder rebuild is healthy and ready, with all fourteen
startup scripts passing. Local Terraform mock-plan execution remains unrun
because this profile lacks Terraform.
[Cold first-start receipt](codex-cold-first-start.json)

## Validation record

Focused UI, transport, package, native identity and installer checks pass. The
native installer fixture supplies identity/runtime shims. Actual image, installed
vendor CLI and provider acceptance are tracked in the progress checklist.

The installed `194122f1` package passed both providers' real signed transport
checks, including the previous build, previous lifetime and stale-generation
rejections, official sign-in prompts, cancellation and signed-out readback.
Both credential locks were free and account CLI processes had exited afterward.
This acceptance used a test Hive principal and a real dedicated Coder session.
Normal hosted Hive authentication completed with an HTML callback, automatic
popup closure and an authenticated app-version readback. The persisted grant
passed the actual credential resolver and Coder identity check. Earlier hosted
callback/status failures remain unexplained. Local single-connection probes
passed, and no authentication source edits followed from those hypotheses.
Hosted browser acceptance passed status, one Connect/Cancel per provider, official
links and prompt controls, mobile card geometry and both providers' status after
reload. Earlier attempts cover the actual stale-build deep link and explicit
current-build selection. The mobile geometry check preceded reload, which
interrupted two read-only status requests. Both fresh reload status requests
returned 200 and signed out. Genuine provider consent remains pending.
[Hosted Accounts acceptance](hosted-accounts-acceptance.json)
[OAuth observations and limitations](oauth-diagnosis.json)

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

The latest full-suite run passed 2,477 tests with 95 optional skips after the
connection parity changes. An earlier full run failed the existing 300 ms PTY
deadline assertion. Its focused retry passed all thirteen cases, followed by
successful full reruns. Native usage and settings browser fixtures passed 20
workflows and 15 accessibility scans. Genuine provider consent and authenticated
native management acceptance remain pending.

The production Worker now has the bridge issuer private-key binding prepared.
The recorded production app build continued serving P02 after preparation.
Template publication and workspace enrollment follow the owner-controlled P03
release. [Production issuer preparation](production-issuer-preparation.json)

## Resumed connection work

On 16 November the owner resumed Hive's incremental epic migration. Application
moves into Codex Studios are paused while P03 connection parity and the remaining
Hive increments proceed. The selected connection reference is Creative Studio
merged main `86b3df8`, including PRs 111 and 112. The owner explicitly included
Codex usage and runtime settings in this increment.

The [connection parity record](connection-parity.md) tracks implementation and
remaining installed/browser acceptance.

## Resumed live acceptance on 17 November

Genuine Codex sign-in and Reconnect completed through the hosted Accounts UI.
Native usage and configuration returned HTTP 200. The native model catalog
contained eight choices, both usage data sources were available and the UI saved
a response-detail change. Reload preserved it and the original value was restored.
Claude official prompt, cancellation, retry and retry cancellation each completed
through the hosted controls. The owner currently has no Claude subscription, so
completed Claude code exchange, authenticated persistence, reconnect and logout
are deferred manual acceptance items.

The workspace updater selected Claude 2.1.326. Signed vendor metadata, exact binary
identity and isolated protocol checks passed before its admission. New images for
all five profiles carry that release admission. The P03 pull request description
tracks the final deployed-build, workspace rebuild and disconnect checks.
[Current P03 review and acceptance](https://github.com/kethalia/hive/pull/453).
