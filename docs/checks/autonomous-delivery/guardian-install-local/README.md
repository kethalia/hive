# Fixed guarded installer: local cross-language proof

The real Python installer, fixed Node outer entry, reviewed CI-built C guardian,
fixed worker shim and host listener passed together. The fixture does not replace
their code or install an alternate authority callback. It uses a synthetic enrolled
project with no task or lease, then an actual signed fixture task-start request to
prove installed preparation remains denied.

Run from the primary software checkout:

```sh
HIVE_TEST_GUARDED_INSTALL=1 \
HIVE_GUARDIAN_ARTIFACT_DIR=/tmp/hive-guardian-ci-17dbf25 \
HIVE_GUARDED_INSTALL_EVIDENCE_PATH=/tmp/guardian-install-parent.json \
node --test scripts/verify-codex-guarded-install.test.mjs
```

The evidence output is created exclusively; choose a new path for each run. The
test is skipped without the explicit opt-in. It validates the artifact manifest
against the current C/build sources, bundles the current canonical modules and
uses the exact existing four hash-pinned vendor binaries. There are no downloads,
dependency installs, model requests, account authentication or cloud operations.

`first-run.json` preserves the first successful run (4.7 seconds). `result.json`
records the final run (4.3 seconds), adding source digests/stability, a global
30-second operation deadline, and explicit post-exit absence of every recorded
runtime PID. Both runs passed. The final fixture records:

- `started`, then `already_running` after the first installer process exits;
- the same private launch receipt and exact outer/guardian/worker identities;
- the configured listener owned by the worker, not the outer;
- rejection of wrong nonce/config/package, stale kernel start ticks and wrong
  parent identity;
- lost-ready acknowledgment refusal without another outer launch, and refusal of
  changed live configuration;
- a correctly signed task-start request blocked before checkout preparation,
  native creation or first-prompt submission;
- no native runtime or authentication files created;
- exact fixture-process cleanup and unchanged metadata for the primary's host
  configuration, installer state and guardian state paths.

## Isolation and limits

The fixture uses an unprivileged user and network namespace with private home,
passwd/group files, `/tmp` and installed package. Host UID 1000 maps to namespace
UID 0; this grants no host-root privilege. A private copy of the exact executing
Node ELF is bound at `/usr/bin/node`. It appears root-owned inside the namespace,
allowing the unchanged installer's root-owned Node policy to be exercised. Normal
host-root files appear unmapped UID 65534 in this namespace. This UID mapping is a
fixture limitation; it is not a production ownership relaxation.

Minimal `/usr` and selected account configuration mounts are used. Preliminary
read-only diagnosis confirmed this environment denies binding `/` as the new root
and denies a read-only remount of `/proc`. The fixture uses the previously proven
existing `/proc` bind, with no new PID namespace, AppArmor change, node access or
privileged fallback. The primary home is not mounted into the fixture. Kernel
process metadata remains visible through the existing proc mount; this fixture is
trusted test code, not proof of an additional adversarial proc sandbox.

A dedicated test-driver subreaper owns only these fixture descendants. It signals
the recorded outer using a pidfd after matching its kernel identity both before
and after opening the handle. The production outer aborts its own guardian tree;
the driver then reaps with Linux `__WALL`, capped at 128 reaps and six seconds.
Only after all fixture children are gone and the parent confirms recorded PIDs
are absent is that fixture's scratch directory removed. No unrelated process,
workspace, checkout, primary auth or installed runtime is cleaned up.

The installed entry still has deny-by-default admission/drain callbacks. This
proof certifies neither a server-authorized preparation nor a cleanup receipt.
Independent persisted admission/barrier authority and actual test-workspace
installation remain separate gates. Native execution/CLI/PTY containment has its
own composed evidence; this test deliberately starts no inference or native
session.
