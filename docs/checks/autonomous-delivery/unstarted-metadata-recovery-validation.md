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

- 33 transfer/inspection/consume/wire cases, including archive tamper/deletion,
  normal abort, live predecessor denial, lease/admission/fence retry, exact temporary
  rename recovery and tampered-temporary denial.
- 5 actual managed-checkout Python cases, including one extension after expiry,
  authorization expiry under lock, replaced checkout, changed HEAD and new consumer.
- The original slice's 132 related Node checks passed, with 2 native opt-in cases skipped;
  separate final bootstrap/history verification passed 28 cases.
- Four real guardian-controller ACK-loss cases distinguish exact committed receipt
  reconciliation from unavailable factual readback; 14 project route cases include
  the authorized owner retry bypassing provision/inspection and reusing its exact grant.
- 10 actual PostgreSQL retirement/provision/recovery cases and 8 Coder lifecycle
  cases passed, including signed enrollment acknowledgement, epic-backed successor,
  malformed SQL, concurrent admission, rollback and maintenance classification.
- The original 25 generated/package/profile cases passed, with 2 opt-in cases skipped;
  the regenerated review-fix package passed 6 narrow archive/bundle checks.
  Global TypeScript, Python syntax, Biome and whitespace checks passed.

Migration51 SHA256:
`edf996a5c5ed4299b0c88df1085a4450f63da5eb9795b54f90fd49a2ad73dbab`.
The independent [production-data restore rehearsal](production-data-capture/20261108-schema51-rehearsal.json)
preserved the original rows and migration history when upgrading an owned local
restore from50 to51.

Generated host package:

| Item | Value |
| --- | --- |
| Manifest SHA256 | `b16854fee6f44c96652c5b8bd64b9b3025e28037f93ab4bfe86c9bd218dd4efe` |
| Raw archive SHA256 | `7e9bb335e1e55415139b23137345e041149c3014c6979b03f977886b47bc2478` |
| Compressed SHA256 | `a33d9aaa32ff8bd42f6f0d1a46f0954ea733ef1900c9e5517ac101251b980268` |
| Size | 207920 compressed bytes; 1249280 raw bytes; 54 members |
| Guardian ELF SHA256 | `ad7facb0f9605c70694f366978408c8b4d5e7a886cb93bdba580835a1255c0fd` |

Provider responses in local tests are explicit doubles; checkout and SQL tests
use owned local fixtures. No live migration, image rollout, task retry, model
inference or production acceptance occurred for this slice. Actual pilot recovery
still requires reviewed migration/package enrollment and fresh owner recovery.
Original request/prompt/readiness submission hashes remain historical evidence.

The review follow-up records a same-recovery intermediate binding, derived exactly
from the archived task. The final consumed flag and receipt are saved together
after a fresh fence. Retrying uses current physical/proof/deadline checks and the
existing once-only renewal receipt. If both a committed effect's acknowledgement
and its factual readback remain unavailable, the existing guardian operator hold
remains; neither identity/provision generation checks nor new enrollment hide that
uncertainty. The actual PostgreSQL suite is enrolled in the existing serial CI job.
