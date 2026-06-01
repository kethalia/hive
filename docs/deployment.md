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

The Git sidebar and clone terminal flow share one runtime contract: the web service, terminal proxy, and Coder agent runtime must agree on `HIVE_PROJECTS_ROOT`. The default value is `/home/coder`, so discovery is not limited to a strict `projects` directory; it finds Git repositories anywhere under that workspace home root while skipping noisy/sensitive hidden directories and known build-output folders.

Use the same value everywhere:

- The web service scans `HIVE_PROJECTS_ROOT` inside the user's selected/running Coder workspace via `coder ssh`, looking for directory or file `.git` metadata.
- The terminal proxy validates clone terminal requests and passes the requested clone path under the same root to the Coder agent PTY command as the tmux cwd.
- The Coder agent runtime must have the repository tree at that exact path string. The web and terminal-proxy containers do not need the repository tree mounted locally; they need Coder API access and the shared root string.

If the configured workspace home root is missing, the sidebar reports that the home folder is unavailable. If the root exists but contains no discoverable Git repositories, the sidebar reports that no Git clones were found. Discovery runs on manual refresh and on the explicit sidebar load path; it does not currently auto-poll for filesystem changes.

Clone terminal sessions are deterministic and reconnectable through the terminal route, but the deterministic `git-clone-<sha>` session name is only an identifier. Sidebar opens mint a short-lived server proof, signed with the shared `COOKIE_SECRET`, over the workspace, agent when available, session name, clone path, and expiry. The terminal proxy rejects missing, expired, tampered, or mismatched proofs before auth/upstream setup and logs only reason codes. A stale bookmarked clone terminal URL may need to be reopened from the Git sidebar to mint a fresh proof.

Hive does not yet expose a dedicated UI control to terminate a clone session. Use the underlying Coder workspace/session tooling when an operator must clean one up before that product surface exists.

Production diagnostics for this flow are intentionally limited today: the web app returns sanitized UI errors for missing roots, empty results, and scan failures; the web and terminal services log reason-code/count summaries without exposing local root paths, tokens, or terminal payloads. There are no dedicated production metrics for clone discovery or clone terminal startup yet.

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
