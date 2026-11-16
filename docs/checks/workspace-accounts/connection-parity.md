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
- [ ] Final serial full suite, Cloudflare build and independent review.
- [x] Publish matching workspace images and verify bundled runtime identity.
- [ ] Exercise both providers and Codex management through the hosted Accounts UI.
- [ ] Complete real provider consent, reload persistence, reconnect and disconnect.

The native fresh-home probe confirms that an absent config file still has a
versioned user layer. Its native version protects the first creation and later
writes. A null expected version permits overwrites, so saves retain the native
version fence.

Primary task evidence and reused workspace identities are preserved under
`connection-parity-local`. Browser tooling runs in `hive-project-preview` and
native acceptance uses `hive-p03-accounts`. The primary owns their lifecycle.

All five preview image publications use source `1aa48f21`. Independent registry
checks verify each manifest/config digest, source label, variant and root-owned
bootstrap files against the local package bytes. The [image receipt](connection-parity-images.json)
records immutable references. The CLI dispatch stalled before job allocation, and
a replacement dispatch completed the same reviewed publication.

The full local Vitest rerun passed 2,473 cases with 95 optional skips. The existing
300 ms PTY deadline assertion failed in the first full run, then passed its
13-case focused retry and the full rerun. Cloudflare, template, bridge, native
installer and worker-router suites passed. The local Cloudflare build succeeded.
The subsequent disconnect-focus correction carries additional card/browser
regressions and receives final integrated checks.
