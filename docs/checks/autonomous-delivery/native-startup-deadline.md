# Bounded native listener startup

The preserved baseline in `native-startup-diagnosis.md` reproduced two native
startup timeouts and observed durable initialization stalled in `fsync` / ext4
journal waits. The prior loop effectively allowed about four seconds when every
TCP connection was immediately refused; its forty attempts were not an explicit
startup deadline. A subsequent successful native listener took 3.557 seconds.

The supervisor now grants **one existing child** an absolute monotonic 20-second
listener deadline, anchored immediately before spawn. This is listener readiness,
separate from the existing five-second protocol request budgets and outer host
budget. Handshakes remain at most 300 ms and pauses at most 100 ms, each capped by
the remaining deadline. A second child is never launched. HTTP handshake rejection
is terminal; redirects and per-message compression are explicitly disabled.

Current execution authority is checked after namespace preparation before spawn,
before each connection attempt, after each awaited fence, and again after the
authenticated socket opens. A 50 ms check bounds detection while awaiting a fence
or handshake. A deadline, lost authority, cancelled AbortSignal or child exit
terminates the pending socket and stops that exact runtime. Late fence completion
cannot return a socket. Runtime stop is idempotent because both listener failure
and the enclosing launch error path invoke it. Existing pinned runtime/version,
namespace readiness and process attestation checks still run before launch returns.

No timeout is reset by a connection attempt or activity. The new helper takes a
private absolute deadline for focused tests; the installed launch always uses the
fixed 20-second constant. No browser/config field controls it.

## Validation

`native-startup-local/deadline-result.json` records source hashes and preserved logs:

- Seven focused readiness cases and two diagnostic/redaction cases passed. A real
  authenticated loopback WebSocket listener appears after **4.5 seconds**, beyond
  the prior effective budget, without a second process. Failure cases verify
  child cleanup and peer EOF, authority revocation, stalled fence deadline,
  post-open authority change, explicit cancellation, child exit and wrong bearer.
- The unchanged three-file actual Codex 0.165 suite passed **57/57 in parallel**
  with bounded instrumentation and again **57/57 without instrumentation**.
  These include metadata root/child/resume/CLI protections, legacy isolation and
  native crash checks, using local canned Responses only.
- All 21 captured exact kernel PID/start identities from the instrumented
  follow-up were gone afterward. The supervisor source hash matched every
  instrumented launch. No cloud/account inference or installed deployment occurred.
- Scoped Biome checks and `git diff --check` passed.

One initial focused-test cleanup exposed its deliberately half-open synthetic
HTTP peer: receiving client EOF did not close the peer's write half. The fixture
now observes EOF, closes its own half and destroys only its tracked sockets in
teardown. No production socket check was relaxed. The initially stuck test driver
was stopped by verified parent/PID handle after confirming it had no child left.

Run:

```sh
node --test scripts/verify-codex-native-startup.test.mjs scripts/probe-native-startup.test.mjs
HIVE_TEST_NATIVE_CODEX=1 node --test --test-concurrency=3 \
  scripts/verify-codex-git-metadata.test.mjs \
  scripts/verify-codex-project-supervisor.test.mjs \
  scripts/verify-codex-native-namespace.test.mjs
```

## Remaining limits

The baseline failures are not overwritten or called impossible. The fix tolerates
the measured startup variability; it does not diagnose or repair the underlying
storage stack. An installed workspace pilot remains required.

The deadline bounds waiting for a listener, not kernel completion of an
uninterruptible IO operation. The existing stop path still waits for the child
after escalation. If the kernel cannot reap it, execution stays unavailable and
there is no successful drain/quiescence receipt. This change introduces no cleanup
authority, automatic retry lifetime, weaker fsync, or writable metadata fallback.
