# Bootstrap-only restart recovery

A Coder autostop can terminate a previously healthy but unused host without its
graceful idle-shutdown receipt. Its next build must preserve that evidence rather
than infer native-tree closure from an empty process list.

The installed constructor can retire only a sealed authorization epoch whose
complete HMAC journal is exactly `begin`, `ready`, `launchIntent`, `open`, and
`startupReady`, with generation one, no admitted projects and no receipts. The
native guardian writes and fsyncs `admissionIntent` before sending its admission
RPC. This positive journal evidence therefore rules out any authorized native
task in the retired epoch. Missing files or a process-list snapshot alone cannot
provide that proof.

Recovery also requires the existing guardian and project-controller flocks, a
positively verified empty project journal with the same lifetime and exact worker
identity, and the old public configuration bytes matching the config digest in
the sealed startup attestation. The old configuration must match the current
Coder deployment, owner, workspace, template, Hive user and issuer. The normal
installer preserves these public bytes privately before replacing configuration.
Historical configurations and all retired signed journals remain retained.
The storage boundary is the existing private home and its two locked journal
directories; provider/PVC continuity remains an independent operator check.

The constructor rejects live matching process identities and ambiguous process
reads. A missing or different identity is recorded only in the current PID
namespace. It is not evidence of global physical process exit. No native
execution lease was granted in an eligible epoch, so retiring its unused
authorization requires no physical native-writer release. The retirement record
explicitly grants neither native-tree closure nor cleanup authority and cannot
stand in for the existing ECHILD receipt.

Project history is archived before the empty current journal is reset. Signed
retirement facts are persisted before the old outer journal is archived. A crash
between these steps can retry against the same facts without discarding history
or duplicating retirement, including when the retry belongs to a different Coder
build. Before changing project state, the guardian seals the original pending
retirement proof. A later build independently revalidates the original startup-only
journal and process identities, then resumes the authenticated pending proof.
The original project evidence and attempted replacement binding remain historical;
they grant no execution authority to that earlier replacement build. The new build
still validates the old public configuration against its own scope and opens only
its own fresh lifetime. Consecutive unused restarts verify earlier bootstrap
archives against their signed outer facts and original signed journals. Native,
idle/task archives, pending controller state, admission attempts, missing scope
material or tampered evidence still hold the workspace for review.

For a host that failed before configuration history was introduced, an operator
may restore independently preserved **public configuration bytes** only when
their exact SHA256 reproduces the existing sealed config digest. This restores
evidence; it does not create authority or change journals, keys, or auth files.
The failed pilot's actual restart acceptance remains pending a reviewed package
and image containing this change.
