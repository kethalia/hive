# Portable workspace actions and discovery

The compatibility Worker admits reviewed Server Action exports by their exact IDs from the
current Next build. It does not admit every action in a module: `workspaces.ts` also contains
SSH-dependent session and file operations. The build extracts eight workspace management/read
exports for `/workspaces`; template status is eligible only if the framework includes it in that
page's worker. Missing required management exports or malformed framework IDs fail the build.
The generated module excludes the framework encryption key and unrelated action metadata.

The build lock now remains held through allowlist generation and the final readiness record.
Readiness binds the policy source, framework output and generated allowlist. Altering that
allowlist invalidates a prepared build. Pinned Next uses a one-byte metadata prefix followed by
40 digest hex characters; only its server-action type is accepted, not use-cache references.

Only same-origin, text/plain, exact-page POST requests carrying a reviewed Next-Action ID pass
this compatibility gate. Unknown actions, query/encoded variants, cross-origin requests,
compressed requests and upgrades remain unavailable. All other non-API page mutations are
rejected: Next's headerless multipart `$ACTION_ID`/`$ACTION_REF` form dispatch cannot bypass the
allowlist. Authentication, framework CSRF protection, argument schemas, fresh Coder access,
existing lifecycle ownership checks and name-confirmed deletion still run in their original
handlers. This change does not perform any Coder operation itself or enable unattended deletion.

The Worker rejects declared Content-Length above64 KiB; this is an early header filter, not a
64 KiB streaming guarantee. The pinned Next action handler separately bounds actual request
bytes to its existing1 MiB default, including bodies without Content-Length. No limit is raised.

Four exact GET discovery resources are portable: workspaces, template-options, agent and
templates. Their existing session authentication and provider access remain. Sessions,
repositories and agent-tools discovery still require the host adapter and remain unavailable.
Restart, generic session/file actions and other unreviewed exports remain unavailable as actions.

Local unit checks cover build mapping, tampered readiness, runtime dispatch and existing
workspace action behavior. Review caught and corrected headerless form dispatch, the framework
ID length and build-lock lifetime. Actual workerd proof is the next gate: use
`node deploy/cloudflare/auth/run-local-integration.mjs --app --portable-actions`.
That probe uses synthetic auth fixtures and invalid lifecycle input; it does not mutate a real
workspace or prove valid Coder lifecycle completion. Browser acceptance and valid account-backed
workspace/discovery requests remain integrated preview checks.
