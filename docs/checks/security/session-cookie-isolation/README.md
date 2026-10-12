# Session-cookie isolation validation

Eight Chrome desktop/mobile checks pass for protected cookie migration and
request-bound terminal tickets. Production cookie serialization, signing,
session lookup, the ticket issuer, terminal authentication, and browser transport
are bundled from repository source. Next request context uses AsyncLocalStorage;
the auth service and terminal WebSocket endpoint are simulated. Live Coder PTY,
clone, audio relay, and deployment integration remain rollout checks.

The browser checks verify a required fresh login, deletion of legacy parent
cookies, absence of the protected cookie on a child hostname, rejected parent
Domain/Path cookie injection, authenticated terminal/audio/status traffic without
Hive cookies, request substitution rejection, and session revocation.

The disposable Browser Testing workspace is `hive-cookie-isolation-browser`.
Its immutable ID, Chrome version, source hashes, provenance, and results are in
[verification.json](verification.json); the complete report is in
[browser-report.json](browser-report.json). Evidence was copied into the primary
repository before cleanup. The workspace was stopped and deleted after the
bounded validation finished; deletion was verified by its immutable ID.

- [Desktop migration check](screenshots/session-cookie-desktop-chromium.png)
- [Mobile migration check](screenshots/session-cookie-mobile-chromium.png)

Reproduce from the repository root in Browser Testing:

```bash
pnpm exec playwright test e2e/session-cookie-isolation.spec.mjs --project=desktop-chromium --project=mobile-chromium --workers=1
```

The harness uses installed Chrome, temporary TLS certificates, and loopback
servers. Dependencies use the pinned lockfile; no browser/system installer is
needed. It closes servers, removes certificate files, and restores fixture
configuration after the run.
