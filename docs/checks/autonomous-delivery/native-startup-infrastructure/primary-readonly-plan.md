# Proposed primary-workspace startup inspection

The new native test workspace and the task-created Infrastructure workspace have
never connected their Coder agents. Both bounded readiness checks ended without
SSH, credential transfer, native enrollment, or a cluster request.

The workspace instructions supplied by the user in this conversation require
agents to “route game, electronics, and privileged infrastructure work to their
matching specialist profiles.” The Infrastructure route is currently unavailable.
Running the following probe in the primary software workspace therefore requires
an explicit exception to that routing instruction. This plan authorizes nothing
by itself.

The prepared [probe](probe.py) uses the existing Rancher credential in memory and
performs only HTTPS GET requests against `rancher.local.kethalia.com`:

- Read Deployment `coder/coder-e6aa588f-89a7-464b-9cf9-a6371d0b819d` in the local cluster.
- Read at most four Pods matching that Deployment's exact selector and identity.
- Read events scoped to each verified Pod UID.
- If the local endpoint is unavailable, read only the local cluster metadata and stop.

The probe has a 75-second overall deadline, a 15-second request timeout, bounded
responses, verified TLS, and disabled redirects. It makes no cluster changes,
fetches no Secrets or raw container logs, and redacts credential and inline
environment values before returning status, image, condition, and event details.
It installs no tools and copies no Coder owner credential.

If the owner approves the exception, an explicitly identified software-profile
variant will run once from the primary workspace. It will preserve the real
profile identity rather than pretending to be an Infrastructure workspace. The
sanitized result will be preserved here; any repair remains a separate decision.


## Approved inspection — 2026-11-07

The owner explicitly approved the read-only Rancher check from the primary.
The software-profile variant preserved the actual profile, removed the inherited
Coder owner credential from its environment, and ran the same fixed deployment,
pod and event GETs. [Sanitized result](primary-readonly-result.json).

The pod is scheduled on `k3s-03`, but remains Pending because Longhorn reports
`FailedAttachVolume`: its exact home volume is not ready for workloads. Neither
`seed-home` nor `dev` has started. The result does not establish the underlying
Longhorn failure cause. No cluster repair, Secret read or raw log collection ran.
