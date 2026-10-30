# Native startup availability diagnosis

The original three-file parallel workload reproduced `native_start_timeout` in
both metadata-protected and legacy isolated runtimes. This is separate from the
passing Git metadata protection assertions. No model account, cloud endpoint,
provider write, credential copy or installed workspace was involved.

## Baseline evidence

`native-startup-local/result.json` records the exact unchanged production source
hashes, test results, timing summaries and cleanup. The adjacent observations
contain bounded, categorized diagnostics rather than raw native stderr.

| Run | Result | Relevant observation |
| --- | --- | --- |
| Two selected actual cases, parallel | 2 passed | First listeners opened about 310 ms after spawn. |
| Same two cases, sequential | 2 passed | First listeners opened about 311 ms after spawn. |
| Full three-file parallel, first | 55 passed, 2 failed | Both isolated modes exhausted all 40 attempts; every connection was refused. |
| Full parallel, second | 57 passed | Legacy listener took 3.557 s; native worker repeatedly waited in `jbd2_log_wait_commit`. |
| Full parallel, third | 57 passed | Legacy listener took 2.134 s; the blocked native thread was in x86-64 syscall 74 (`fsync`) and `jbd2_log_wait_commit`. |
| Full parallel, fourth | 57 passed | First isolated listeners opened about 310 ms after spawn. |
| Full sequential | 57 passed | First isolated listeners opened about 314 ms after spawn. |

The failed first parallel run had live wrapper/monitor/native processes, only the
expected read-only alias warning, no listener-ready category, no handshake timeout,
no HTTP authentication rejection and no early child exit. Preparation before spawn
also grew to 4.5–5.8 s versus roughly 0.6–0.7 s normally. Later instrumentation
localized comparable preparation delays after version verification and before
namespace completion. The native state's real-home filesystem is ext4 on device
8:80; the direct fixture homes under `/tmp` use overlayfs. At the failed run the
cgroup showed no additional CPU throttling, OOM event or PID-limit event. Later
sampling showed IO pressure. These observations support storage latency as a
cause of delayed initialization. The exact timed-out run lacked per-thread syscall
capture, so this does **not** establish the cause of every earlier failure or the
identity of the synchronized file. No node/storage-policy diagnosis is claimed.

## Diagnostic implementation and limits

The fixture-only loader transforms the existing supervisor module in memory after
checking unique exact source markers. It changes stderr from ignored to a drained
pipe and adds bounded telemetry. It preserves the original arguments, provider,
namespace, token, 40-attempt loop, 300 ms handshake, 100 ms poll and cleanup. The
observer caps stderr consumption at 16 KiB and records only fixed categories. It
never writes stderr text, auth values, arbitrary filenames, syscall buffers or
pointer arguments. Poll/process reads and telemetry do add small observation
overhead; the baseline uninstrumented failures remain independently preserved in
`git-metadata-local/parallel-failure-tests.txt`.

Instrumentation was added in stages: the first reproduction has process-level
wait states; the second adds bounded thread aggregation; the third adds syscall
and descriptor categories; the fourth and final sequential run additionally
support descriptor type/device classification. The final harness tightens root
PID/start/parent checks and has redaction/source-drift unit tests. Final diagnostic
source hashes in `result.json` describe that reviewable harness, not a claim that
all earlier stages were byte-identical. Two preliminary loader-marker failures
started no native process and are excluded from the native matrix.

All 120 captured kernel PID/start identities were absent after the matrix. Tests
removed their own recorded fixture directories. Production source hashes matched
before/after. No production behavior changed during this baseline investigation.

Reproduce the original baseline from the matching source revision:

```sh
diag_dir=$(mktemp -d /tmp/hive-native-startup-review-XXXXXX)
HIVE_TEST_NATIVE_CODEX=1 HIVE_NATIVE_STARTUP_DIAGNOSTICS="$diag_dir" \
  node --experimental-loader ./scripts/probe-native-startup-loader.mjs \
  --test --test-concurrency=3 \
  scripts/verify-codex-git-metadata.test.mjs \
  scripts/verify-codex-project-supervisor.test.mjs \
  scripts/verify-codex-native-namespace.test.mjs
```

Use concurrency 1 for the sequential control. Each test already has a bounded
deadline. These are local canned Responses fixtures, not account inference.

## Authorized follow-up

The roughly four-second effective budget is brittle against the observed
3.557-second durable initialization stall. The parent approved a separate bounded
availability change: one absolute monotonic 20-second listener deadline for the
same process, preserving short polling, current authority checks, exact token and
identity checks, cancellation, early exit and cleanup. No automatic second launch,
weaker filesystem durability or isolation change is authorized by this finding.
The baseline failure remains preserved; follow-up results must use separate source
hashes and evidence. Installed deployment acceptance remains a separate gate.
