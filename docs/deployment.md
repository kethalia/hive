# Hive Deployment and Rollback Notes

## Audience and outcome

This runbook is for internal engineers deploying Hive through GitOps-managed Helm releases. After reading it, you should be able to promote a built image set, confirm the rollout, and choose a safe rollback path when a release fails.

## Release contract

Hive uses a build-once, promote-on-release contract:

1. Pull requests build the production images with a `sha-<short>` tag.
2. The release preflight verifies every production image tag exists before the Version Packages pull request can merge.
3. The release workflow retags the already-built `sha-<short>` images to versioned release tags and `latest`; it does not rebuild them.
4. GitOps values pin the chart to the image tags that should run in the cluster.

The image set is:

- `hive-web`
- `hive-auth`
- `hive-terminal`
- `hive-migrate`

`hive-migrate` is part of the release contract because the umbrella chart runs Prisma migrations from that image before the application pods roll.

## Rollout safety defaults

The service charts render conservative rollout controls by default:

- Deployments set a progress deadline so stuck rollouts fail instead of waiting indefinitely.
- Deployments use rolling updates with zero unavailable pods and one surge pod.
- Startup probes render separately from liveness and readiness probes so slow starts fail clearly without weakening steady-state checks.
- PodDisruptionBudgets are supported but disabled by default.

These defaults are preview-safe: one-replica preview releases are not blocked by disruption budgets, but failed rollouts still become visible through Kubernetes Deployment status.

## Current deployment exceptions

The following exceptions are intentional and should be revisited only when the matching runtime capability exists:

- PodDisruptionBudgets are opt-in. Enable them only for production releases that run at least two replicas or autoscaling with `minReplicas >= 2`.
- The web and terminal services still use TCP probes because they do not expose unauthenticated HTTP health endpoints. Switch them to HTTP probes only after stable health endpoints exist.
- The migration Job is an Argo CD Sync hook with sync-wave ordering, not a Helm hook. Successful hook Jobs may be deleted after completion, so absence of the Job after a healthy sync is expected.
- Database migrations are forward-only operationally. A failed app rollout can be rolled back to a compatible image, but do not assume the database schema can be automatically rolled back.

## Auth-service caller authentication

`AUTH_SERVICE_SECRET` is required in the web, auth, and terminal-proxy environments.
Use the same value in all three services: 32 random bytes encoded as exactly 64 hex
characters, generated independently of `COOKIE_SECRET` and `ENCRYPTION_KEY`.
Store it in the deployment's secret manager; do not commit it, put it in a ConfigMap,
or pass it to browsers or Coder workspaces. The auth service refuses to start with
missing or malformed configuration. Clients refuse to make unauthenticated calls.

All auth-service requests require `Authorization: Bearer <AUTH_SERVICE_SECRET>`,
including `/login`, `/logout`, and session/credential/token lookups. Only the exact
`GET /health` probe remains public. The public Hive login route sends the credential
server-side, so the browser's login flow and session cookie format are unchanged.
Authenticated service requests do not follow redirects.

For Compose, configure `AUTH_SERVICE_SECRET` in the local environment before starting
the stack; both local and production Compose files require it. Native development
processes must load the same value. For Helm, each service references the
`AUTH_SERVICE_SECRET` key in its `existingSecret` (or its default secret name).
If the umbrella manages the Secret, set `sharedSecret.AUTH_SERVICE_SECRET` through
the secret-management integration. Its empty default is intentionally unusable;
when `sharedSecret` is disabled, the externally managed Secret must contain the key.

Use a staged rollout for an existing deployment:

1. Provision the secret in all three service environments and restart existing pods
   so they load it. Older images ignore the extra variable.
2. Promote the new web and terminal images first. They send the credential and
   remain compatible with the older auth service. Verify login, session lookup,
   logout, and terminal authentication.
3. Promote the new auth image. It enforces the credential before routing or reading
   a request body. Verify that a session ID alone gets `401`, authenticated calls
   work, and `GET /health` still succeeds without credentials.

Keep the auth service internal-only and retain network restrictions; caller
authentication does not encrypt HTTP traffic. Use TLS/mTLS when service traffic
crosses an untrusted network. Live secret provisioning, rollout verification, and
Helm validation belong in the Infrastructure workspace.

Rotate the credential by updating the managed Secret and restarting all three
services together during a coordinated maintenance window. Only one credential is
accepted at a time; mixed values cause backend authentication failures. To roll
back a client image, roll back auth enforcement first. Rolling back the auth image
restores the old exposure, so prefer a forward fix and keep network isolation.

## Workspace app origin isolation

Workspace tools load from Coder's app domains. Hive uses the authenticated
`/api/v2/applications/auth-redirect` flow to bootstrap app access; the user's Coder
API token remains server-side. No workspace response body or headers are forwarded
through Hive's web origin. The retired `/api/workspace-proxy/...` route returns
inert `410` JSON for every method, including script and direct-navigation URLs.
Open old bookmarks again through Hive's tool controls.

Use a Coder wildcard app host outside Hive's session-cookie scope. For example,
`*.apps.example.com` can be separate from a Hive deployment at `hive.example.com`
with cookies scoped to `.hive.example.com`; `*.apps.hive.example.com` overlaps
those cookies and is rejected. A different port on the same hostname also fails
the check because cookies do not distinguish ports. Both the incoming Hive host
and `HIVE_PUBLIC_ORIGIN`, when configured, are checked along with known cookie
migration domains. The Coder authentication redirect must retain the authorized
app origin.

Embedded tools explicitly deny camera and microphone access, retain their own
origin/storage, and allow normal app scripts, forms, downloads, clipboard use,
pointer lock, and fullscreen. App authentication URLs stay in memory rather than
persisted pane state. If an app host changes and the document's framing policy
needs updating, reload Hive before opening it in the legacy tool panel.

Validate login, File Browser folder navigation/downloads, editor panes, and
desktop connectivity through the deployed Coder app URLs after rollout. The
browser regression uses the production panel and security logic with simulated
app-auth endpoints; it checks cookie delivery, same-origin access, microphone
permissions, fullscreen, and inert legacy URLs. It does not exercise a live Coder
deployment or the File Browser/KasmVNC binaries. Current automatic cookie scope,
duplicate-cookie handling, and general CSRF protections remain separate follow-up
work; origin isolation does not replace those controls.

## Git clone discovery and clone terminals

The Git sidebar and clone terminal flow share one runtime contract: the web service, terminal proxy, and Coder agent runtime must agree on `HIVE_PROJECTS_ROOT`. The value must be an absolute POSIX path. The default value is `/home/coder`, so discovery is not limited to a strict `projects` directory; it finds Git repositories anywhere under that workspace home root while skipping noisy/sensitive hidden directories and known build-output folders.

Use the same value everywhere:

- The web service scans `HIVE_PROJECTS_ROOT` inside the selected Coder workspace via `coder ssh`, looking for directory or file `.git` metadata.
- The terminal proxy validates clone terminal requests and passes the requested clone path under the same root to the Coder agent PTY command as the tmux cwd.
- The Coder template's `projects_root` parameter exports the same path as `HIVE_PROJECTS_ROOT`; File Browser uses it as its runtime root and Hive derives embedded File Browser paths relative to it.
- The Coder agent runtime must have the repository tree at that exact path string. The web and terminal-proxy containers do not need the repository tree mounted locally; they need Coder API access and the shared root string.

If the configured workspace home root is missing, the workspace-scoped Git section reports that the home folder is unavailable. If the root exists but contains no discoverable Git repositories, the workspace-scoped Git section reports that no Git clones were found. Discovery runs when a workspace row is expanded, when the active workspace route auto-expands, and on manual refresh for expanded workspaces; it does not currently auto-poll for filesystem changes.

Clone terminal sessions are deterministic and reconnectable through the terminal route, but the deterministic `git-clone-<sha>` session name is only an identifier. Workspace Git opens mint a short-lived server proof, signed with the shared `COOKIE_SECRET`, over the workspace, agent when available, session name, clone path, and expiry. The terminal proxy rejects missing, expired, tampered, or mismatched proofs before auth/upstream setup and logs only reason codes. A stale bookmarked clone terminal URL may need to be reopened from that workspace's Git section to mint a fresh proof.

Hive does not yet expose a dedicated UI control to terminate a clone session. Use the underlying Coder workspace/session tooling when an operator must clean one up before that product surface exists.

The terminal proxy keeps a bounded in-memory history of authorized terminal and Git session events. Operators can inspect it from **Diagnostics → Live session events** or open **Session logs** from a terminal/Git window header to tile the live log beside the session. The `/session-events` endpoint supports workspace-scoped incremental reads and applies the same Coder-session authorization boundary as keepalive status.

Events cover connection acceptance, upstream connect/close/error, browser disconnect/error, heartbeat state, resize frames, and one-second input/output traffic summaries. Traffic events contain byte and frame counts only. Command input, terminal output, tokens, clone proofs, Coder URLs, and filesystem paths are never retained. History is process-local and bounded, so a terminal-proxy restart is visible as a new instance identifier and starts a fresh event history.

## Deploy

1. Confirm the image build completed for all four images in the release contract.
2. Confirm the release preflight passed on the Version Packages pull request.
3. Merge the release change through the normal protected-branch process.
4. Let Argo CD sync the GitOps application. Do not apply manifests manually in production.
5. Verify the migration hook outcome and the three service rollouts.

From a machine with cluster access, the lightweight verifier can check the expected workload state:

```bash
./scripts/verify-deployment.sh --namespace <namespace> --release <helm-release>
```

Use `--context <kube-context>` when the desired cluster is not the active kubeconfig context.

## Existing database baseline adoption

The `hive-migrate` image runs a catalog/history preflight before `prisma migrate deploy`.
It inspects the PostgreSQL schema selected by `DATABASE_URL` (`public` by default), including
non-default schema names. The check does not write tables or migration history. Its messages omit
connection credentials and raw CLI output.

Schema names containing double quotes are rejected before invoking Prisma: Prisma 6 does not
escape these names in its connection setup. Other schema names are safely encoded in preflight SQL.

| Database state | Result |
| --- | --- |
| Empty schema, including an empty `_prisma_migrations` table | Normal migration deployment proceeds. |
| Completed, non-rolled-back `0_init` baseline with no unresolved migration | Normal migration deployment proceeds; Prisma handles pending migrations. |
| Existing tables, views, sequences, standalone composites, enums, or domains without a completed baseline | `HIVE_MIGRATION_BASELINE_REQUIRED`; deployment stops for explicit reconciliation. |
| Unfinished, non-rolled-back migration history | `HIVE_MIGRATION_FAILED_HISTORY`; investigate and repair the failed migration. |
| Connection, permission, or malformed-history failure | Preflight fails; application rollout stays blocked. |

The preflight checks history and schema occupancy, not complete schema compatibility. A recorded
baseline is not proof that later schema drift is safe. Original migration files remain immutable;
the runner never runs `migrate resolve`, resets a database, or rewrites historical rows.

For a preflight-only check from the repository, provide the approved target's `DATABASE_URL`
through your secret-management mechanism, then run:

```bash
pnpm --filter hive-migrate preflight
pnpm --filter @hive/db exec prisma migrate status --schema prisma/schema.prisma
```

`migrate status` can return nonzero for pending or divergent history; inspect the result rather
than treating it as authorization to change history. Inside the deployed migration image, the
equivalent check is `node src/migrate.mjs --check`.

For an existing schema created before this migration history was adopted:

1. Use the Infrastructure workspace for live database operations. Confirm the exact database and
   schema, obtain a verified backup, and test restoration and the procedure on an isolated copy.
   Preserve the existing `_prisma_migrations` contents and schema definition as evidence.
2. Identify the exact historical migration prefix already represented by that schema. Replay that
   prefix in an empty reference database and compare it with the restored copy before marking
   anything applied. Review constraints, indexes, types, and migration data effects as well as
   columns; a comparison with today's Prisma datamodel alone does not establish the historical
   baseline. Prisma 6's `migrate diff --exit-code` returns 0 for no schema difference, 2 for a
   difference, and 1 for an error. Resolve discrepancies before proceeding.
3. For a schema verified to match **only `0_init`**, explicitly mark that migration as applied:

   ```bash
   pnpm --filter @hive/db exec prisma migrate resolve --applied 0_init --schema prisma/schema.prisma
   ```

   This changes migration metadata and skips the baseline SQL; it does not create or validate the
   baseline's objects. If later migrations are already represented, verify and explicitly resolve
   each applicable migration in order. Do not apply the `0_init`-only example blindly to a database
   produced by a later `db push` or to a schema with failed/partial migrations. Incompatible
   historical layouts require a reviewed reconciliation plan before retrying.
4. Review the remaining migration SQL and preserve data affected by it. In particular,
   `20260814000000_remove_legacy_tasks` drops the retired `tasks`, `task_logs`, and `workspaces`
   tables and their enums. Baseline adoption itself does not authorize that pending data removal.
5. Rerun the preflight on the restored copy, deploy the pending migrations there, and verify retained
   user/session data and application behavior. Only after the live operation is authorized should
   the same verified metadata reconciliation be performed on the target.
6. Deploy the updated `hive-migrate` image through GitOps and resync Argo CD. Confirm the migration
   hook succeeds before application pods roll. No schema reset or migration-file editing is needed.

See [Prisma 6 baselining](https://www.prisma.io/docs/orm/v6/prisma-migrate/workflows/baselining)
and the [Prisma 6 CLI reference](https://www.prisma.io/docs/orm/v6/reference/prisma-cli-reference).
This is an operator-guided migration procedure, not automatic adoption of an arbitrary schema.

## Verify manually

If the verifier is not available, check these signals directly:

```bash
kubectl -n <namespace> rollout status deployment/<release>-hive-web --timeout=10m
kubectl -n <namespace> rollout status deployment/<release>-hive-auth --timeout=10m
kubectl -n <namespace> rollout status deployment/<release>-hive-terminal --timeout=10m
```

If the migration hook Job still exists, it should be complete. If it is absent after Argo CD reports a healthy sync, that can be normal because successful hook Jobs are cleaned up.

## Roll back

Choose the least risky rollback that matches the failure mode:

1. **Image-only application failure:** revert the GitOps image tag to the previous compatible version and let Argo CD sync. Verify all three Deployments roll out.
2. **Migration hook failure before app pods roll:** inspect the hook Job logs, fix the migration image or database connectivity, then resync. Avoid forcing application pods forward when migrations have failed.
3. **Schema compatibility issue after migration succeeds:** do not blindly roll back to an older app image unless it is known to work with the migrated schema. Prefer a forward fix or a compatibility patch.
4. **Bad chart/config change:** revert the GitOps values or chart version change, then sync and verify the Deployment progress deadline clears.

After any rollback, run the verifier again and check the user-facing web and terminal entry points.

## Terminal connection continuity

The dashboard owns terminal surfaces above the workspace routes. Navigating to another workspace
or tool parks the surface in an inert, hidden host instead of destroying its renderer and socket.
Returning within 30 minutes reuses that surface and re-registers its terminal/input callbacks with
the active page. At most 24 parked surfaces are retained; the oldest are released first if that
limit is exceeded. Visible surfaces are never evicted. Dashboard unmount (including logout),
explicit session deletion, and session rename release the relevant clients. Releasing a client
never kills tmux. Existing tabs/boards within a mounted page retain their existing lifetime.

Parked connections continue to participate in the proxy's workspace keepalive until released.
Consequently, visiting a workspace can keep it running for the 30-minute retention period and
Coder's remaining extended deadline. Closing the browser or dashboard releases its attachments;
this is not an always-on workspace policy.

New clients negotiate `hive-terminal-v1`. On that subprotocol:

- The proxy sends the text control frame `{"type":"hive:ready"}` only after the Coder PTY socket
  opens. An HTTP/WebSocket upgrade alone does not reset retries or enable terminal input.
- The proxy sends all PTY output as binary frames. Terminal output that happens to resemble JSON
  cannot impersonate readiness or health messages.
- The client retains the latest requested dimensions during recovery and sends them on readiness.
- While foregrounded, the client probes the proxy every 15 seconds and on resume. Matching
  `hive:ping` / `hive:pong` IDs confirm that the proxy is responsive and still has an open, ready
  upstream socket. An unanswered probe expires after eight seconds. Browser suspension cancels
  the probe deadline; late callbacks after an event-loop sleep trigger a fresh probe.
- The existing native WebSocket heartbeats independently check the browser and Coder legs. The
  browser receives a five-minute grace period (plus one heartbeat tick), while the upstream
  retains its existing three-missed-check threshold. Received traffic also proves leg activity.

Old clients without a subprotocol retain the previous output format, allowing the proxy to deploy
before the web client. A new client talking to an old proxy retries until the compatible proxy is
available. Deploy the proxy before the web client when rolling these services separately.

Queued browser output is bounded at 4 MiB. A slow attachment is closed with retryable code 1013
and a `browser_backpressure` diagnostic event, protecting other sessions from unbounded buffering.
SIGTERM/SIGINT stop acceptance of new terminal upgrades and close existing sockets with retryable
code 1012, with forced cleanup after 25 seconds. This does not transfer live sockets between pods;
redundant replicas and infrastructure restart/ingress monitoring remain deployment concerns.

The web client never uses refreshed clone proofs as renderer identity. Proof refreshes only affect
subsequent handshakes, retaining the current surface and its content.

### Continuity validation

The unit suites exercise readiness, retry counting, suspended/half-open connections, latest-size
replay, route reuse, simultaneous views, explicit removal, and 30-minute expiry. Proxy integration
tests use real WebSockets and verify upstream readiness, input forwarding, control/output separation,
and compatibility with existing clients.

`e2e/terminal-continuity.spec.mjs` bundles the production session provider and transport into an
isolated test server, outside the Next.js application. Run it in Browser Testing:

```sh
pnpm exec playwright test e2e/terminal-continuity.spec.mjs
```

The harness verifies DOM/output retention, input isolation, navigation without new sockets, and
half-open recovery. It does not replace production preview checks of xterm sizing, clipboard,
clone authorization, real Coder workspaces, or physical-device background suspension.

## Host-only session cookie migration

This release deliberately requires one fresh login. Production sets
`__Host-hive-session` with Secure, HttpOnly, SameSite=Lax, Path=/, and no Domain.
The signing purpose changes, invalidating old signed values even if a client
renames them. Legacy `hive-session` cookies are never accepted in production.
Any duplicate of the selected name is rejected, including identical/empty
values. Unknown historical cookie paths may remain in the browser but cannot
authenticate; login/logout expire the known host-only and parent-domain forms.

Keep the old `COOKIE_DOMAIN` value on web temporarily as a deletion target;
it no longer broadens a live cookie. Cloudflare's `PUBLIC_COOKIE_DOMAIN` likewise
only scopes legacy deletion headers. Remove those values after migration.
The Worker preserves host-only scope for live cookies even when the legacy
setting remains configured. Public deployments require HTTPS and browsers that enforce the
[__Host- cookie prefix](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Set-Cookie#cookie_prefixes)
are required for production. Local HTTP development keeps unprefixed host-only
cookies and also adopts the new signing purpose.

Web, terminal, and the Cloudflare Worker (if used) must be upgraded together.
Allow a short terminal interruption during the coordinated rollout, then reload
Hive and sign in. Old web versions cannot mint tickets, and old terminal versions
cannot accept them. Avoid prolonged mixed-version serving during this migration.
No COOKIE_SECRET rotation or new shared secret is required; web and terminal
continue sharing the existing COOKIE_SECRET and AUTH_SERVICE_SECRET.

`NEXT_PUBLIC_TERMINAL_WS_URL` must name the actual terminal HTTPS/WSS authority
(or a same-origin path such as `/terminal`); production refuses plaintext ticket
delivery unless both the web and terminal URL use the exact loopback names
`localhost`, `127.0.0.1`, or `[::1]`. This supports the production-stage local
Compose image at `http://localhost:3000` with `ws://localhost:3001`; the Secure,
HttpOnly, host-only production cookie stays enabled. Use a browser that treats
localhost as a trusted context. Private-network addresses and hostname suffix
lookalikes are not included in the exception. On web, set `HIVE_PUBLIC_ORIGIN` to the exact public HTTPS origin if a
reverse proxy rewrites the request URL. The ticket issuer checks Origin against
this value; forwarded headers alone are not trusted. On terminal, set
`TERMINAL_PUBLIC_ORIGIN` to its exact public HTTPS origin only if its reverse
proxy rewrites Host. Otherwise ticket audiences match the incoming Host.
Both local and production Compose stacks forward `TERMINAL_PUBLIC_ORIGIN` and
`ALLOWED_ORIGINS` from the environment. Leave the public-origin setting empty for
direct loopback access. Configure `ALLOWED_ORIGINS` for numeric loopback addresses
or public hostnames; its unchanged default allows only localhost.
Keep the web origin in terminal `ALLOWED_ORIGINS` and allow Authorization in CORS
preflights; the service includes that header in its existing allowed-origin policy.

Tickets bind a SHA-256 digest of the exact request path/query so clone paths
and their embedded proofs do not inflate handshake headers. Substituting a path
or query still invalidates the ticket.

The browser requests a fresh 30-second, request-bound ticket for every terminal
or audio connection and each status/event HTTP request. Tickets live only in
memory and travel through WebSocket subprotocols or Authorization headers. Do
not log those headers or ticket-issuer response bodies at ingress/edge layers.
HTTP proxy requests omit cookies and refuse redirects. These tickets cannot be
used as web-session cookies and do not carry the user's Coder token; proxy
session/token lookup and workspace authorization still apply. Existing connected
PTYs are not terminated merely because their handshake ticket expires.

After rollout, verify login/logout and rejection of old cookies on production
and preview hosts; open terminal and audio, reconnect a terminal/clone session,
and check keepalive status/session events. Verify browser network requests do
not deliver Hive's account cookie to the terminal or workspace app hosts. Check
that ticket expiry, modified targets, and revoked sessions are rejected. Browser
fixture evidence does not substitute for this live Coder rollout verification.
