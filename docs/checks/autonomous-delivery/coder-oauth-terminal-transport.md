# OAuth terminal transport source gate

Cloudflare terminal and paste transports preserve the private auth service's
credential source: OAuth uses `Authorization: Bearer`; legacy and managed keys
retain `Coder-Session-Token`. No provider credential reaches browser messages.
Paste uses the credential from its latest successful owner/build reauthorization
before opening its fixed writer PTY.

The authorization budget is 20 seconds to accommodate the auth service's bounded
15-second OAuth refresh. The terminal setup handshake allows 30 seconds overall.
The 20-second refresh scheduling interval, 150-second attachment lifetime,
original session/token/preview deadline, owner/build checks, and paste limits are
preserved. Refresh failure still closes the attachment; paste never retries an
uncertain write.

Validation: focused terminal runtime, relay, paste runtime and paste transport
unit tests cover OAuth and legacy headers, fresh paste credentials, a 15-second
refresh, and the unchanged attachment lifetime. Local Workerd proofs run with
`node deploy/cloudflare/app/run-local-generic-terminal.mjs --oauth` and
`node deploy/cloudflare/app/run-local-terminal-paste.mjs --oauth` against explicit
synthetic private auth/Coder services. Evidence records `credentialMode: oauth`;
no real provider, workspace, browser, or production operation occurs. Omitting
`--oauth` retains the legacy fixture for compatibility checks.

These are source and local-runtime gates. Actual OAuth-authenticated terminal and
paste acceptance in the native preview remains a live pilot gate.
