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
