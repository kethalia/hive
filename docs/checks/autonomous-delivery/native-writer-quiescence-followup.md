# PID namespace compatibility after the real-home correction

The corrected private `/tmp` and read-only native alias directory do **not**
resolve the whole-PID namespace compatibility blocker. The production writer
hold remains required. These probes change only their own local fixtures; no
installed bundle, test workspace, infrastructure policy or production flag changed.

The original stdio proof was rerun against the corrected canonical launcher:

```sh
HIVE_TEST_NATIVE_CODEX=1 node scripts/probe-codex-writer-quiescence.mjs
```

`native-writer-quiescence-after-scratch-fix.json` retains the result: detached
writer lifetime controls pass, a fresh proc mount returns EPERM, and native
`thread/resume` with the inherited host proc bind reaches its ten-second deadline.
Returning to the ordinary launcher restores history. These remain distinct
failures; the exact kernel cause of EPERM has not been established.

A separate real-home WebSocket comparison then removes the stdio transport as
an explanation:

```sh
HIVE_TEST_NATIVE_CODEX=1 node scripts/probe-codex-writer-quiescence-ws.mjs
pnpm exec biome check scripts/probe-codex-writer-quiescence-ws.mjs
```

`native-writer-quiescence-ws.json` records all three sequential cases using the
same private native home and persisted thread:

| Case | Observed result |
| --- | --- |
| Canonical namespace | Native 0.165 initialize, managed requirements, thread start, one local-mock turn, sandbox command and same-thread tmux CLI display pass. |
| Add only `--unshare-pid` | WebSocket initialize and managed requirements pass; exact persisted `thread/resume` reaches the seven-second probe deadline. |
| Restore canonical namespace | Exact thread resumes with its persisted answer; sandbox command and same-thread CLI display pass. |

Only one Responses request was served by the local fixture across all three
cases. No account inference was used. CLI attach did not submit another turn.
All probe-owned wrappers and tmux servers were stopped and their fixture trees
removed. The first development invocation had an incorrect tmux pane selector;
that harness failure was corrected before this comparison and is not native
compatibility evidence.

The test proves failure within a bounded deadline, not an infinite deadlock or
its cause. The same read-only alias warning and bundled-bwrap fallback notice
occur in successful and unsuccessful cases. They do not explain the difference.
No production timeout was changed. The fresh-proc denial and existing masked
proc layout still warrant the narrowly scoped Infrastructure diagnosis described
in `native-writer-quiescence.md`; no broader privileges or AppArmor change is
justified by this result.

Whole-runtime PID termination would still stop every project sharing that native
runtime. Any future implementation needs an explicit global admission/drain
barrier and pinned init/pidfd lifetime evidence, or separate runtime isolation per
project. Thread completion, terminal inventory, a quiet process scan and successful
fixture tests remain insufficient authority for production cleanup or completion.
