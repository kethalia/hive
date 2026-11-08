# Unstarted native reservation recovery

This slice fixes the supervisor's five-second wait around the existing 20/23/25-second
guardian chain. New callers negotiate a server-deadline-bound launch approval;
queue time, cancellation and expiry after durable reservation cannot start a runtime.

The exact reviewed predecessor can transfer a blocked, prepared task only from
`reservationRequested`, with completed matching guardian authority and no possible
native/thread/prompt history. Normal controller-abort shutdown is distinct from
tree closure. All predecessor journals and verified bootstrap histories remain
private and unchanged. The successor starts empty and keeps the same task held
until authenticated owner recovery. Fresh admission and a new launch reservation
replace the old execution authority.

Forward migration51 adds `authorization_retired`. It frees only the physical
runtime slot; original launch receipts, checkout, lease, epic start and writer rows
remain retained. Application owner/Coder/signature verification is the existing
trust boundary; SQL additionally enforces exact scope, immutable receipts, absence
of native facts and serialized transitions. This does not claim protection from a
fully compromised controller database role fabricating every prerequisite.

An expired retained checkout lease can be revalidated only under the existing
checkout lock and current owner authorization. Its ID, generation and incarnation
remain unchanged. A once-only receipt retains the original expiry; retries recheck
physical/source/consumer state without another extension. This operation alone
does not authorize native execution or input.

Validation completed locally:

- 29 transfer/inspection/consume/wire cases, including archive tamper/deletion,
  normal abort, live predecessor denial, expired-lease consume ACK loss and replay.
- 5 actual managed-checkout Python cases, including one extension after expiry,
  authorization expiry under lock, replaced checkout, changed HEAD and new consumer.
- 132 related Node checks passed, with 2 existing native opt-in cases skipped;
  separate final bootstrap/history verification passed 28 cases.
- 10 actual PostgreSQL retirement/provision/recovery cases and 8 Coder lifecycle
  cases passed, including signed enrollment acknowledgement, epic-backed successor,
  malformed SQL, concurrent admission, rollback and maintenance classification.
- 25 generated/package/profile cases passed, with 2 existing opt-in cases skipped.
  Global TypeScript, Python syntax, Biome and whitespace checks passed.

Migration51 SHA256:
`edf996a5c5ed4299b0c88df1085a4450f63da5eb9795b54f90fd49a2ad73dbab`.
The independent [production-data restore rehearsal](production-data-capture/20261108-schema51-rehearsal.json)
preserved the original rows and migration history when upgrading an owned local
restore from50 to51.

Generated host package:

| Item | Value |
| --- | --- |
| Manifest SHA256 | `cf5fda1362e3ba4cd09a7e7d035b6228cf1f6de782bad0df2526fd9c4129975d` |
| Raw archive SHA256 | `5de8171f9ae8d4e6867aa86f13dcaac319a03bfcb4cd10f3b78ff3b8f8d560b1` |
| Compressed SHA256 | `1989d8637541987a4bfe966e0534e7936b9955d2f50e84cbced39726b4c560ec` |
| Size | 207276 compressed bytes; 1245696 raw bytes; 54 members |
| Guardian ELF SHA256 | `ad7facb0f9605c70694f366978408c8b4d5e7a886cb93bdba580835a1255c0fd` |

Provider responses in local tests are explicit doubles; checkout and SQL tests
use owned local fixtures. No live migration, image rollout, task retry, model
inference or production acceptance occurred for this slice. Actual pilot recovery
still requires reviewed migration/package enrollment and fresh owner recovery.
Original request/prompt/readiness submission hashes remain historical evidence.
