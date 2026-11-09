# Portable notification hook setup

Source/local checkpoint, November 6. Live flags, providers and workspace installations
remain unchanged. This completes the missing server/host implementation path for
ordinary terminal-agent notification setup, separately from template publication notices.

The existing signed agent bridge has one new fixed operation, `install-notifications`.
Its strict request contains only staged source identity/generation/creation time and
callback credential. Callers cannot supply a command, path, source code or URL. The
host derives `/api/notifications/events` from its configured Hive issuer, reads the
reviewed installer and hook from its pinned package manifest and passes the credential
only through child stdin. It never puts that credential in argv, environment, stdout
or a public response. The package's two new members are `notifications-install.py`
and `notifications-hook.py`; startup and the existing installer verify the exact set.

The helper reuses `scripts/notifications/install.py` and `agent-hook.py`. Its original
Node/SSH mode is preserved. Portable mode returns a private structured receipt only
after successful process exit, binding source/generation/creation time, fixed callback
origin and a credential digest. The signed client validates all fields against its own
request after checking the pinned process identity and signature. The HTTP source
route returns only success or fixed error labels; it never exports the receipt/digest.
No private receipt or callback credential is preserved in public evidence.

The shared file lock and atomic writes preserve unrelated Codex/Claude configuration
and the bridge's captured custom config homes. Reinstalling the same generation is
idempotent. A newer installed generation defeats delayed older writes; a conflicting
credential at the same generation fails closed. Partial writes, killed/timed-out helpers,
lost responses or post-execution build changes remain uncertain and are not confirmed.
The existing bridge supplies bounded execution/cancellation and never retries a mutation.
A failure is not a claim that all earlier file writes were undone.

`HIVE_AGENT_NOTIFICATION_SOURCES_ENABLED=true` admits only source POST/DELETE
through the app compatibility boundary; it is absent/default-off in shipped configs.
POST also requires migrated callback ingress enabled, configured public origin equal
to the agent issuer, an authenticated same-origin owner request and a healthy installed
pinned bridge. Owner/build/app identity is verified before and after inspection and
installation. Only then is the matching staged credential conditionally confirmed.
Confirmation checks cancellation inside its database transaction; cancellation during
SQL rolls back the token switch. Unknown results retain active/pending overlap for
safe inspection/retry. Late earlier-generation responses and revoked sources cannot
replace current credentials or resurrect rows.

DELETE is deliberately database-only. It verifies the authenticated owner and configured
Coder identity, locks that current user identity and deletes only their workspace source.
It succeeds idempotently even when the workspace/bridge is stopped, unavailable or gone.
It does not execute a remote helper or remove user configuration. Existing hook files may
remain but their revoked source bearer is rejected, matching prior disconnect semantics.

## Callback transport correction

The initial ingress proof exercised the Next POST directly and missed the private
Preview wrapper: that wrapper required a separate Preview bearer and stripped the
source Authorization header. The app now has one fixed transport exception for exact
configured-origin, no-query POST `/api/notifications/events` when its ingress flag is
true. Only that route skips the Preview cookie/bearer gate and retains source
Authorization for the Next route's **own current PostgreSQL source verification**.
This grants no browser/UI access to private compatibility previews. Flag-off, wrong
method, query, upgrade/action requests and other paths keep their existing boundaries.
Native Previews now explicitly configure `HIVE_PREVIEW_ACCESS_REQUIRED=false` so users
reach ordinary Hive login without a second bearer/cookie gate; normal sessions, CSRF,
owner checks and callback source verification still apply. Legacy/unspecified native
mode retains private access. No Preview credential is installed into workspace hooks.

The existing app wrapper is factored into `app/composition.ts`, with the production
`worker.ts` still composing the generated Next handler and exact build's portable-action
manifest. This permits an actual wrapper/route/database proof without modifying shared
generated Next artifacts; it introduces no additional public transport or bridge.

## Validation and remaining gates

- Actual loopback signed host plus real Python helper: fixed origin, stdin-only credential,
  unrelated/custom configs, repeat install, stale/newer generations, conflicting credentials
  and replaced pinned assets.
- Signed client/service and HTTP orchestration: exact private receipts, changed build,
  failed/lost/cancelled mutation, pre-stage readiness and disconnected-workspace revocation.
- Real PostgreSQL: staged/active overlap, receipt-driven confirmation, unknown-result retry,
  cancelled confirmation transaction, revocation races and newer-generation fencing.
- [Workerd bridge proof](agent-notification-installer-local/bridge-workerd.json): actual
  Worker service/client and signed local host execute the pinned notification installer twice;
  the provider reader/cookie exchange is synthetic and the user config remains preserved.
- [Assembled callback proof](agent-notifications-local/workerd.json): actual production app
  composition, migrated Next POST, real staged pending source credential and full PrismaNeon
  PostgreSQL verify 202/401 behavior without a Preview cookie. Wrong method/query/flag-off/UI
  requests cannot use the source bearer as Preview access. Actual jobs/shared sender runs with
  zero subscriptions, so this proves no real provider push delivery.

Both Workerd proofs are local only, with no remote binding/provider operations. New package
assets/mirrors are synchronized by the primary's coordinated build owner, not a parallel sync.
Remaining live gates include actual installed-bridge admission/readback, both agents' emitted
hooks, browser foreground/background push and terminal deep-link acceptance, original user
config/trust behavior, Node worker drain, aggregate jobs budgets and scheduler ownership.
No account-connection refactor (F09/F10), production cutover or final merge is implied.
