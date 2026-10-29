# Read-only Infrastructure handoff for the native PID gate

A new Infrastructure workspace alone is **not sufficient** to read node audit
logs. Repository source supplies pinned infrastructure clients, but no cluster
or node credential provisioning. Do not create a new workspace expecting that
access to appear, and do not borrow another task's credentials or workspace.

## Source findings

- `templates/infrastructure/CLAUDE.md` explicitly says the template does not
  grant cluster access.
- `templates/infrastructure/main.tf` disables service-account token automount,
  runs UID1000 with all capabilities dropped and privilege escalation disabled,
  and injects only the Coder agent token, USER and HOME into the dev container.
  Its ordinary storage is the workspace home PVC. No kubeconfig, node SSH key,
  host log mount or Kubernetes credential Secret is provisioned.
- Its optional host-bootstrap mount is a read-only Downward API projection for
  the software host, not node audit authority. Specialist startup removes
  inherited owner Coder authentication.
- The existing cluster repository's `docs/runbooks/nextcloud-cookbook.md`
  records that a fresh Infrastructure workspace had kubectl but no kubeconfig.
  `docs/runbooks/hive-security-rollout.md` describes Rancher/kubeconfig access as
  task-local. This is historical context, not reusable credential authorization.
- `k8s-cluster/infrastructure/codex-sandbox/README.md` refers to an existing
  controlled node-maintenance access method without provisioning it. It also
  records an earlier fresh-proc EPERM with native's no-proc fallback. The source
  does not establish an existing read-only node-log endpoint or authorized
  credential for this task. The architecture's mention of Loki does not prove
  node kernel/audit logs are collected or readable there.

No infrastructure CLI or network access was used for these findings.

## Minimal capability required

Prefer an existing, explicitly authorized read-only node journal/audit reader
(or existing log service that actually collects the node kernel audit stream),
plus read-only Kubernetes pod metadata to identify the exact node and runtime.
Provision that access separately in a task-owned Infrastructure workspace.
Never copy credentials from the unrelated `linkwarden-security-infra` task.

Node SSH with existing journal-reading authorization could perform this without
cluster mutations; plain cluster `get pods`/`get pods/log` permission does not
by itself establish access to the node's kernel journal. If no existing reader
exists, node access or new log collection would need additional authorization.
Creating a privileged/hostPID diagnostic pod, a hostPath mount, a DaemonSet,
`kubectl debug node`, or widening RBAC/policy is outside the current authorization.
There is no reason to perform any of those operations speculatively.

## Bounded read-only command plan

Run only in Infrastructure, after the target deployment and credentials have
been independently established. The first command selects metadata only; never
print pod environment variables, Secrets or kubeconfig content:

```sh
kubectl --context <verified-context> -n <verified-coder-namespace> get pods \
  -l com.coder.workspace.id=22c4f094-46f0-4a76-86ca-37ad74254872 \
  -o 'jsonpath={range .items[*]}{.metadata.name}{"\t"}{.metadata.uid}{"\t"}{.spec.nodeName}{"\t"}{.status.containerStatuses[?(@.name=="dev")].containerID}{"\n"}{end}'
```

Confirm the pod corresponds to the independently recorded current Coder build
before diagnosing it. Do not substitute the unrelated task's pod. On its verified
node, through the existing authorized reader, request a small UTC window around
one approved synthetic repro, initially no more than two minutes:

```sh
journalctl --kernel --since '<UTC start>' --until '<UTC end>' \
  --no-pager --output=short-iso --grep='apparmor|DENIED|audit|bwrap'
```

A reader may need the existing node journal group or existing equivalent
operator authority. Do not add membership, invoke sudo to obtain new authority,
change audit rules or load an audit-policy copy. If the reader is denied or logs
are absent, report that limitation instead of treating absence as kernel proof.
Keep raw results private and export only matching mount denials for the synthetic
probe (timestamp, profile, operation, error, filesystem, mount flags/destination,
process identity). Unrelated audit records may contain sensitive arguments.

From the exact test container, using an already-authorized read-only session,
record public runtime metadata alongside the repro:

```sh
cat /proc/self/attr/current
awk '/^(Cap(Inh|Prm|Eff|Bnd|Amb)|NoNewPrivs|Seccomp):/' /proc/self/status
awk '$5 == "/proc" || index($5,"/proc/") == 1' /proc/self/mountinfo
```

Record current kernel version, node profile digest and pod security-context
fields through the authorized reader. Do not change mounts or proc masks. The
existing synthetic PID/proc probe may then be rerun in the reviewed task scope
with timestamps aligned to the node audit window; do not run model inference.

## Decision gate

An AppArmor denial must identify the exact rejected operation and rule context
before proposing a policy change. If no AppArmor denial explains EPERM, inspect
existing runtime proc masking and kernel restrictions with the node operator;
absence of a log is not proof that AppArmor permitted the syscall. Preserve
capabilities zero, NoNewPrivs, runtime masks and the current native isolation.
The bounded WS/stdin resume timeouts remain a separate compatibility failure
until linked by evidence. Production quiescence stays held throughout.
