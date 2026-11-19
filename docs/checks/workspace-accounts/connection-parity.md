# Creative Studio connection parity in Hive P03

The owner resumed Hive P03 on 16 November 2026 and included Codex usage and runtime
settings from Creative Studio PR 112. Creative Studio merged main `86b3df8` supplies
the reference authentication, countdown, usage and configuration behavior.

## Implementation

- Both provider cards use scoped, bounded, single-flight account requests,
  cancellable reads, serial pending polls and focus/visibility readback.
- The native provider challenge appears inside Accounts with official links,
  expiry feedback, cancellation and confirmed disconnect. Codex supplies device
  code copying and verified account summary fields. Claude accepts its one-time
  code in the existing password input and clears submitted values.
- Codex Usage presents available native quota windows, credits, reset metadata
  and token summaries. Unsupported data has explicit availability feedback.
- Runtime settings use the native model catalog, six allowlisted user settings,
  field origins, configuration-version conflicts and read-only execution-policy
  details. Defaults follow native precedence for new sessions.
- Management operations use the selected workspace build, the signed bridge,
  the existing credential lock and the same account lifetime/generation. Config
  writes use native version comparison, advance the generation and obtain fresh
  readback after an uncertain result. Client recovery performs status reads.
- A signed capability identifies runtimes supporting usage/settings. Legacy
  account payloads remain accepted through the existing status contracts.

## Validation progress

- [x] Focused UI regression tests for native usage, settings saves, uncertain
  acknowledgements, config-version review, retained data, aborts and retry.
- [x] Native manager, route, client/service and account compatibility regressions.
- [x] Exact pinned Codex 0.165.0 fresh-home config read/create/version-conflict
  probe in the reused P03 workspace, without provider or model calls.
- [x] Final serial full suite, Cloudflare build and independent review.
- [x] Publish matching workspace images and verify bundled runtime identity.
- [x] Exercise provider prompts and Codex management through the hosted Accounts UI.
- [x] Complete genuine Codex consent, reload persistence and Reconnect.
- [x] Record the owner’s unavailable Claude subscription and deferred authenticated checks.

The native fresh-home probe confirms that an absent config file still has a
versioned user layer. Its native version protects the first creation and later
writes. A null expected version permits overwrites, so saves retain the native
version fence.

Primary task evidence and reused workspace identities are preserved under
`connection-parity-local`. Browser tooling runs in `hive-project-preview` and
native acceptance uses `hive-p03-accounts`. The primary owns their lifecycle.

The initial native management images used source `1aa48f21`. The Claude link
correction publishes source `eca79f06`, with game/electronics retries from
`84a53296`. That follow-up changes only generated template hashes. Their image
recipe, native helper and template runtime sources are identical. Independent registry checks verify each
manifest/config digest, source label, variant and root-owned bootstrap files
against the local package bytes. They also match the digest in the successful
workflow push log. The [image receipt](connection-parity-images.json) records the
verified immutable references. An initial CLI dispatch stalled before job
allocation, and a replacement completed the same reviewed publication.

The existing 300 ms PTY deadline assertion failed in an earlier full run, then
passed its 13-case focused retry and subsequent full reruns. Cloudflare, template,
bridge, native installer and worker-router suites passed. The local Cloudflare
build succeeded. Independent backend and UI reviews completed, including a
correction restoring focus to the disconnect-dialog opener.

## Real Claude terminal-link correction

The initial hosted prompt exposed a terminal OSC8 hyperlink artifact. A BEL
terminator joined the link target and visible duplicate into one URL. Destination
checks accepted the malformed query. The driver now waits for complete delimited
URLs and excludes terminal controls. Native and web validators reject literal
controls and repeated authorization targets while preserving encoded redirects.

Synthetic PTY regressions cover BEL, ESC-ST and fragmented PKCE/state values. An
isolated probe against the exact admitted Claude 2.1.325 executable returned one
clean complete OAuth URL, then canceled and reaped its child. Real credentials
and provider consent were absent from that probe. The updated native package
was installed from the independently verified CLI image in the reused isolated
4 GiB workspace. All startup scripts completed and the agent became healthy.

This parser correction must accompany the retained Claude package when the
paused shared-foundation migration resumes.

The corrected URI build passed 2,477 Vitest tests with 95 optional skips, plus
41 bridge checks and six driver PTY regressions. The refreshed actual-source
fixture proof passed 20 workflows and 15 axe scans at desktop and mobile widths.
It uses dummy API data. Two HTTP 409 replies and three request aborts exercise
unknown acknowledgements and cancellation. Accessibility incompletes for vendor
focus guards and contrast were retained alongside manual guard/focus checks.
Hosted authentication and native credential persistence require provider consent.

## Hosted prompt acceptance after the correction

The existing repository-connected Workers Build `56c0cb6f-2363-497b-9f2f-959868548fb0`
succeeded for `84a53296`. The hosted Accounts run served application build
`4347091c-a549-4d3f-b5b9-002e5aff4faf` with workspace build
`89209228-3e3c-4f13-8981-8da0a9aa9f0e` and package manifest
`18d60c6c5efc93e9bf568fea36e5a45ce0c378692b87a3633b5f02e497b60307`.
Both provider Connect actions returned HTTP 200 and pending challenges through
normal UI controls. Codex rendered its device code, Claude rendered a password
input, reload restored both pending attempts and the 390 px card had no overflow.
The stale build was held until explicit current-build selection.

The actual Claude challenge contained exactly one authorization target, one state,
one PKCE challenge with S256 and zero terminal controls. Provider approval remains
a human step. Authenticated native usage/settings and completed credential
persistence, reconnect and disconnect still require that approval.

Both final provider prompts expired at 16:26 UTC without completed consent.
The normal hosted status routes returned HTTP 200, signed out, generation 2 and
no pending attempt for each provider afterward. New prompts are required for
human acceptance. The current local Cloudflare build and 76 template checks pass.
Its generated Better Auth bundle emits a duplicate-key warning inherited from
vendor code. The build completes successfully.

## Live acceptance resumed on 17 November

Codex genuine consent completed and the normal hosted UI obtained both native
usage sources and the eight-choice native model catalog. A response-detail save
returned a confirmed native result, persisted across reload and was restored to
its original value. A separate genuine approval completed the Reconnect flow.
Claude prompt cancellation and retry/cancellation returned HTTP 200. Completed
Claude consent and authenticated operations are deferred while the owner has no
active subscription. The current PR description records final deployed rebuild
and disconnect results.

Startup selected Claude 2.1.326, which required the release admission documented
in the signed-vendor and isolated-runtime receipt. The compatibility correction
uses the existing verification and adapter path. All five current image receipts
use source `51c26c48`, with successful publication logs and independently checked
OCI/bootstrap bytes. [Claude 2.1.326 admission](claude-2.1.326-admission.json).
