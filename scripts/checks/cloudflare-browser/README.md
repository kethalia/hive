# Bounded private-preview browser proof

Run from the primary software workspace. Browser execution is pinned to the
primary-created disposable Browser Testing workspace recorded in
`docs/checks/autonomous-delivery/cloudflare-browser/workspace-creation.json`.
The wrapper rechecks owner, UUID, template, creation time, name and running build
against Coder before SSH; it does not start, stop or delete the workspace.

Installed dependency: Playwright1.61.1, matching the repository lock, under the
private `/tmp/hive-cloudflare-browser-ld5o18ur` scratch directory. The exact npm
package/lock files are preserved here. Installation used
`PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm install --ignore-scripts --no-audit --no-fund`.
No browser, system dependency, clone or node_modules copy was created. Existing
Chrome155.0.8059.79 is used at `/usr/bin/google-chrome`.

Preparation uploads source, runs syntax/policy tests and launches/closes Chrome
on its blank initial state. It does not navigate to the preview:

```sh
python3 scripts/checks/cloudflare-browser/remote.py prepare
node --test scripts/checks/cloudflare-browser/policy.test.mjs
```

Only after the parent activates/reviews the preview and provides private test
credentials, run:

```sh
python3 scripts/checks/cloudflare-browser/remote.py run --auth-file <private-mode0600-file>
```

The input JSON has exactly `email`, `password`, `previewBearer`. It is read
privately in the primary, sent through encrypted SSH stdin, then passed to Node
stdin in memory. It is never written in the specialist workspace or printed.
The wrapper suppresses raw exceptions/stdout failures that could contain
sensitive data. No screenshots, traces, console/error messages, page text,
request/response bodies, passwords, cookies or tokens are persisted. Cookies
are inspected/replayed in memory solely for the logout invalidation check.
The report contains booleans, dimensions, aggregate counts and fixed stage names.

The exact target is `https://hive-app-compatibility-preview.b00ste.workers.dev`.
The shared ceiling is 200 forwarded requests and180seconds, including the one
preview-cookie bootstrap, all assets, login and logout checks. Requests reserve
a slot before network; route fetches use `maxRedirects:0` and reject foreign or
unapproved redirect targets. Bootstrap/replay API calls bypass browser routes,
so they explicitly reserve from the same budget and disable redirects.
Service workers, WebSockets, popup navigation, downloads and foreign origins
are blocked. No terminal/project/model/delivery endpoints or generic server
actions are allowed. Only the fixed read-only delivery authentication gate is permitted for the
old-session rejection check; discovery endpoints are blocked. Backend Coder calls made by
ordinary login/dashboard are part of that UI behavior; browser API credentials
are never sent directly to Coder.

The sequence checks credentials-only fixed-host login form/body, normal UI
login, secure HttpOnly Hive session, dashboard desktop/mobile horizontal overflow,
API logout, session-cookie clearing and401when replaying the old session
against the fixed read-only delivery endpoint. Normal UI logout is unverified. Logout does not claim to revoke
or rotate the account's retained Coder API key; parent-owned rotation remains a
separate follow-up.

A failed check emits only the fixed stage name. Do not automatically retry a
failed live run or exceed the parent-approved aggregate request budget. Preserve
the sanitized result in the primary before parent-owned disposable cleanup.

## Reviewed candidate limitations and driver failure proof

The current preview blocks every Next-Action and `/api/discovery/*` before
application authentication. `/settings` redirects into a window whose
`getSettingsWindowAction` must complete before the existing Sign out button
renders. No server action is allowlisted by this harness. The reviewed candidate
therefore checks **API logout initiated by same-origin browser fetch**, followed
by navigation to the login form. Normal UI logout remains explicitly unverified.
Old-cookie replay targets only GET `/api/delivery/tasks`, whose authentication
gate returns401 before performing authenticated work. POST delivery mutations
remain blocked. Automatic dashboard discovery is blocked and must not be
presented as a verified live-refresh capability.

Current source selector references: `[data-dashboard-main]` is in
`src/app/(dashboard)/layout.tsx`; `Sign out` is in
`src/components/settings-content.tsx`, mounted through
`src/components/workspaces/HiveWorkspacePane.tsx` after its settings server action.
The login inputs and Sign in button are in `src/app/login/login-form.tsx`.
Secure, HttpOnly, exact host-only domain, Path=/ and SameSite=Lax are required
assertions, matching `src/lib/auth/session-cookie.ts` and the production
`__Host-hive-session` name.

`driver-lifecycle.mjs` runs only in Browser Testing. It loads one synthetic
loopback HTTP page using the same ordinary `chromium.launch` API as the harness,
verifies the direct Chrome parent/group and kernel start identities, then kills
its own Node driver with SIGKILL. On installed Chrome155.0.8059.79, the root and
all eight tracked Chrome processes exited within100ms on driver-pipe closure;
no fallback kill was needed. Evidence is
`docs/checks/autonomous-delivery/cloudflare-browser/driver-lifecycle.json`.
The Python190second subprocess timeout kills the same Node driver; normal
180second deadline and ordinary completion first close context/browser explicitly.
This is a bounded test of this installed browser lifecycle, not a general
writer-quiescence claim. No other session, process group or workspace was touched.

Only one login POST may reserve a network slot, including retries or concurrent
browser submissions. Ordinary requests stop at199; the final slot is available
only to one fixed failure-cleanup POST `/api/auth/logout`. On any failure after
the login attempt, cleanup runs before the request context/cookies are closed,
with no redirects or retries and a maximum five-second timeout within the same
180second deadline. The result records only `cleanupAttempted` and
`cleanupSucceeded`. If the deadline already expired, no cleanup request is sent;
the attempted cleanup reports false success and requires parent follow-up.
Six policy tests cover the single login fence, reserved final slot, pre-network
accounting, fixed cleanup scope and deadline refusal.

## First failure and reduced-budget diagnostic candidate

The first live result is preserved unchanged in `live-result.json`:21forwarded
requests, zero login POSTs,7scope-blocked requests and13.8seconds elapsed. Its
aggregate counters cannot identify blocked resources or establish the cause.
The current candidate precharges those21requests and allows at most179more
(including the cleanup-only slot), within150seconds. It still permits only one
login POST; no automatic live retry is authorized by preparation.

`diagnostics.mjs` exports only fixed resource/endpoint/status categories, bounded
page-error and CSP-directive counts, and form booleans/counters. It never exports
URLs, queries, messages, headers, body text, values or validation messages. The
harness waits at most eight seconds for the current React form's onSubmit handler,
then checks HTML validity and controlled-value agreement before clicking. React's
internal property marker is a version-specific diagnostic/readiness signal,
validated with the current bundled React fixture, not an authorization boundary.

The synthetic real-Chrome fixture proved that an actionable SSR form can have
readyState=complete while its handler is absent: immediate fill/click produced
zero POSTs; waiting for hydration then filling produced exactly one. This is a
possible mechanism, **not proof of the original live failure's cause**. Its
sanitized evidence is `hydration-fixture.json`. To reproduce, build the local
React artifact in the primary, transfer it as `fixture-app.js` beside
`hydration-fixture.mjs` and `diagnostics.mjs` in the recorded Browser scratch,
then execute the fixture there. It serves only a synthetic loopback page:

```sh
node scripts/checks/cloudflare-browser/build-hydration-fixture.mjs /tmp/hive-hydration-fixture-app.js
# Browser Testing, approved private scratch only:
node hydration-fixture.mjs
```

No preview request is made by the fixture or `remote.py prepare`. Candidate
activation and a single reduced-budget follow-up remain parent-controlled.
