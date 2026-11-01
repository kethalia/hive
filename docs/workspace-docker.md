# Workspace Docker engines

Software and Infrastructure workspaces can opt into **Workspace Docker engine**
when first created. It defaults off. Existing workspaces and the active templates
are not restarted or promoted by merging this change. Browser, Game and Electronics
do not expose this parameter.

## Execution boundary

The Coder agent stays in the regular Kubernetes runtime, as UID 1000, with all
capabilities dropped, privilege escalation disabled and `hive-codex-v1` enforced.
Only a separate, credential-free Docker engine pod runs in `sysbox-runc` with
`hostUsers:false`. The engine's AppArmor/seccomp relaxation does not apply to the
agent. There are no host mounts, host namespaces, host Docker socket, Kubernetes
API token, or Coder agent credentials in the engine configuration.

The two pods share only this workspace's home and a workspace-owned Longhorn PVC.
The dev container mounts only the socket subdirectory of the Docker PVC; engine
data remains outside its filesystem. The Unix socket is group-accessible to UID/GID
1000. Docker access still grants authority over the workspace's mounted home,
including credentials deliberately saved there. It is a developer tool, not an
untrusted-code sandbox. Restricted Codex processes must fail to reach that socket;
read/write/network sandbox validation remains an acceptance requirement.

Both pods select the already validated Sysbox canary node. Required pod affinity
places the engine beside its agent, satisfying Longhorn ReadWriteOnce mounts.
The existing agent deployment and home PVC retain their identities. An immutable
parameter prevents accidentally deleting Docker data by toggling the option.
Docker's 20 GiB PVC survives stop/start and is removed with the owning workspace.

The pinned Docker engine uses the container network's actual MTU, obtained through
netlink. Docker's default and user-defined bridge networks use that MTU. The
classic overlay2 store is selected so image and named-volume state live on the PVC.
The kubelet does not inject service environment variables into the Sysbox pod.

## Using it

`DOCKER_HOST=unix:///run/hive-docker/docker.sock` is present in the agent environment
and dev container. Use `docker info` to check readiness; the agent can connect while
the engine is still starting. Docker's startup/readiness probes retry for up to
three minutes. A failed engine leaves the agent available to inspect/recover the
workspace; do not bypass it with a privileged pod or host socket.

Workspace bind mounts use identical `/home/coder/...` paths in both pods.
`docker build`, `docker run`, Compose and `act` use the private engine. Published
ports run in the **engine pod**, so access them through `$HIVE_DOCKER_HOSTNAME`
from the workspace and forward that connection through Coder when needed.
`localhost` in a host-executed command remains the agent pod; container jobs and
their services share Docker networks as usual. Do not assume a host-executed act
job can reach a service via agent localhost.

A headless Service supplies the engine's DNS name. A NetworkPolicy permits
incoming connections only from the owning agent pod, DNS to kube-dns, and outbound
public HTTP/HTTPS for registry/action downloads. Private/tailnet/link-local ranges
are excluded. Docker's API listens only on the shared Unix socket, never TCP.
NetworkPolicy application is eventual: it is not a pre-start isolation barrier.
Do not put credentials or untrusted workloads in the engine during policy startup.

## Validation and rollout

Terraform validation and scaffold tests check parameter scope, engine/user-namespace
configuration, workspace-specific mounts, same-node affinity, no API credentials,
and unchanged agent sandbox. Live acceptance must also exercise Docker build/run,
UID-1000 bind writes, a named volume, act container/service jobs, actual agent sandbox
denials with positive controls, stop/start recovery and a separate workspace engine.
Use an inactive Coder template version and task-created disposable workspaces;
preserve evidence in the primary workspace. Template promotion and restarting
existing workspaces are separate actions, after these checks pass.

This follows [Coder's Sysbox guidance](https://coder.com/docs/admin/templates/extending-templates/docker-in-workspaces)
while keeping the credential-bearing agent out of Sysbox. Kubernetes provider 2.38
does not expose `hostUsers` in its typed pod resource, so the engine uses
`kubernetes_manifest`; the agent retains its existing typed Deployment.
