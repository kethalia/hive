# OAuth popup and Safari navigation follow-up

The owner reported a Safari download prompt after Coder consent and requested a
separate floating sign-in window on 14 November 2026.

## Comparison with the epic

Epic [PR402](https://github.com/kethalia/hive/pull/402), commit `81e5e084`,
corrected sign-in from an immutable preview origin. Its rejected start request
returned an empty 400 response without a content type. The correction used the
registered canonical start origin, readable plaintext responses and `nosniff`.
The original record is
[preserved on the epic](https://github.com/kethalia/hive/blob/codex/delivery-system-design/docs/checks/autonomous-delivery/coder-oauth-preview-alias.md).

The P02 live check on `109224ae` found a successful 302 callback with
`Content-Type: application/json`, `nosniff`, and no attachment header. Headed
Chrome followed it to the authenticated HTML page and recorded zero downloads.
The supplied Safari screenshot shows Coder's authorization-complete page. The
current Safari download cause remains unconfirmed.

The updated callback wrapper explicitly types navigation redirects as
`text/plain; charset=utf-8` with `nosniff`, preserving framework cookies and
Location. JSON sign-in responses retain their media type. Regression checks
cover successful and failed redirects and the framework's existing API responses.

## Popup flow

The Continue button opens a 560-by-720 popup synchronously during the click,
before the asynchronous sign-in request. Coder login and consent happen there.
Hive displays progress in the original window.

Better Auth retains responsibility for PKCE, OAuth state, callback handling,
credentials and session creation. The server accepts an optional validated UUID
to select a fixed internal completion URL. The registered Coder callback remains
`/api/auth/callback/coder`.

The completion page verifies the Hive session, then sends its result to the
original window using an exact target origin. The parent accepts only its own
popup, matching origin and matching attempt UUID. Messages contain a completion
boolean and correlation UUID. The popup closes and the parent opens workspaces.

Blocked popups allocate no OAuth flow and display a retry instruction. Closing
the popup cancels its pending request and restores the button. A ten-minute UI
deadline follows Better Auth's state lifetime. Unmounting releases the popup,
request, event listener and timers. An unavailable opener has a visible return
path in the completion page.

Browsers control the final window presentation. Mobile browsers can present a
tab. The deployed Coder login response currently has no COOP/COEP header.

## Validation

The focused callback, popup, completion-page and existing login tests pass 53
checks. Independent review found no confirmed P1/P2 issue in the new popup flow.
Live popup acceptance and final CI are recorded as they complete.

The Browser Testing workspace runs Linux Chrome. Safari and the pinned
Playwright WebKit executable are unavailable, so native Safari confirmation
requires the owner's browser.
