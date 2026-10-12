# PR 303 review-fix validation

Ten Chrome desktop/mobile checks pass. The original HTTPS cookie-isolation,
request-binding, and revocation checks still pass. Added HTTP localhost checks
run with NODE_ENV=production and the protected Secure/HttpOnly cookie. They
verify authenticated terminal/audio WebSockets (including a long clone path
and real clone proof), compact tickets, and cookie-free status/event HTTP reads.
Cookies remain scoped by hostname, so localhost WebSockets on another port may
receive the localhost cookie; public sibling-host tests still verify no cookie
delivery. The plaintext exception requires both web and terminal URL hostnames
to be exactly localhost, 127.0.0.1, or [::1].

The fixture runs repository cookie/session/ticket issuer/verifier/transport code.
Next request context uses AsyncLocalStorage, with a simulated auth-service store
and minimal WebSocket endpoints. Live Coder PTY/clone/audio authorization and
Compose container integration remain rollout checks; no containers are started.

The disposable Browser Testing workspace is `hive-cookie-review-browser`.
Provenance, immutable ID, source hashes, and results are recorded in
[verification.json](verification.json). The complete report is in
[browser-report.json](browser-report.json). Evidence was copied into the primary
repository before workspace cleanup. The workspace was stopped and deleted,
and its immutable ID was verified absent.

An additional explicit-TLS-port normalization refinement is covered by the final
terminal service suite and typecheck. The browser-tested and final service
hashes are recorded separately in verification.json.

Reproduce in Browser Testing from the repository root:

```bash
pnpm exec playwright test e2e/session-cookie-isolation.spec.mjs --project=desktop-chromium --project=mobile-chromium --workers=1
```
