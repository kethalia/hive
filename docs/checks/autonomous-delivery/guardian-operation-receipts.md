# Committed guardian operation receipts

Migration 42 adds immutable receipts for `prepare`, `checkout`, `native` and `fence`.
The runtime lock, operation effects and receipt insert share one serializable transaction.
The key is owner/runtime/original event ID; a collision with a different full signed-envelope
digest, action or input generation is rejected. Exact fresh retries return the original JSON
wire response before operation generation/intent checks. JSON dates are ISO strings.

`operation_readback` requires a fresh outer signature, nonce and full original signed request.
The original may be expired. Its original key, lifetime, build, config and exact receipt must
still match. Missing receipts remain unknown. Readback returns historical generations and
response without refreshing runtime authority, admitting a project or repeating an effect.
The host must obtain a new fence before releasing its hold. Blocked-intent fencing is unchanged.

Only lifetimes created with the immutable `operationReceiptsEnabled` birth marker can record
receipts. Pre-migration lifetimes keep the false default and cannot be retroactively certified.
Each response is at most 64 KiB, with at most 1,024 receipts per runtime (64 MiB of response
data at the maximum, plus indexes and metadata). Exhaustion rejects new operations before
effects; exact replay, readback and factual closure remain available. Receipts are retained;
there is no age-based deletion of held or historical evidence in this slice.

Pool wait plus transaction timeout fit within the remaining signed-frame lifetime. Final
database-clock and abort checks roll back effects and receipt together after late SQL.
Fresh identity and transport frames share the existing bounded, abortable clock resampling:
one I/O tick and at most one wait for a timestamp within one second, followed by strict time
checks. No timestamp is clamped and a still-future frame is rejected.

Local PostgreSQL tests cover all four operation receipts, exact and concurrent replay,
collision/signature/scope failures, missing receipts, pre-migration holds, actual expired
original frames, expired/blocked authority, revoked native registration, immutable/oversized
receipts, count exhaustion and receipt-insert deadline/cancellation rollback. Clock tests
reproduce the old rejection before the fix and cover resampling, remaining future timestamps,
excessive offsets and cancellation. No provider or live database mutations were used.
