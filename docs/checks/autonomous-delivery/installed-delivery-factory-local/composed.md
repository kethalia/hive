# Actual factory composition with local provider doubles

`composed.json` records a source-stable run of the installed factory through actual
manager, native observer, source publisher/state/application clients, signed
PostgreSQL services, and the actual outer guardian journal reader. The publisher
and application use their real private-FD protocol implementations and real
protected Python/Git/managed-receipt implementations. The artifact store and GitHub
HTTP are explicit local doubles. Separate simulated trusted CI evidence completes
the implementation; native command exit is never converted into CI evidence.

The fixture registers a manager claim, observes a synthetic known child, publishes
source B from physical base A, completes the implementation, then marks the root
terminal. It reserves and applies B through the actual outer/server/Python path.
Only after applied readback and input release does it issue one synthetic next-root
receipt for a pending dependent validation step. Detached HEAD/index move to B;
later dirty source bytes, unrelated staged bytes, untracked and ignored files
remain unchanged. The physical attempt still has `quiescedAt: null`.

The test does **not** launch an actual native model, guardian C process, CLI or PTY.
Initial enrollment/kernel identity and the native/input inventory are explicit
synthetic facts. Their installed proofs are separate. No network provider, cloud,
account inference, real PR or deployment was used. The collector's real CI
challenge is intentionally rejected as a pending prerequisite; model-readable
fresh evidence status is the next slice, not established by this result.

The first actual-spool application attempt failed before reserve HTTP. The outer
reader required a nonexistent top-level `progressionProtocol`; the actual writer
persists it on each claim. Earlier synthetic composition had invented the field.
`composed-first-abi-failure.txt` preserves that failure. The correction checks the
actual current claim's protocol and retains the other signed spool/cursor/cohort
checks. A real-spool unit regression is owned by the Cloudflare agent. An early
one-step fixture subsequently applied B correctly but expected an unnecessary
continuation after task convergence; the final case includes a pending dependent
validation step so continuation ordering is meaningful.

Run from the repository with its pinned dependencies and the isolated local test DB:

```sh
HIVE_DELIVERY_TEST_DATABASE_URL=postgresql://coder@127.0.0.1:35235/hive_delivery_test \
HIVE_INSTALLED_DELIVERY_EVIDENCE_PATH=/tmp/hive-factory-parent.json \
pnpm exec vitest run src/__tests__/lib/codex-session/installed-delivery-factory.integration.test.ts \
  --no-file-parallelism --reporter=verbose
```

This preserves parent evidence separately. Failed fixtures retain private scratch;
successful fixtures remove only their own home after close and exact child-group
ESRCH checks. Provider/home substitution is test-only process interception, never
an installed helper selector. Child environments contain no inherited owner,
GitHub or native credentials. Source hashes, not an uncommitted HEAD claim, bind
the tested implementation.
