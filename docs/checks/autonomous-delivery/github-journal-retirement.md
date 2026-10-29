# Bounded GitHub retry journal retention

The installed collector previously stopped accepting new request IDs after its
32-file private journal filled. It now reclaims authenticated entries only when
capacity is reached and their validated server challenge expired at least one
minute ago. Exact snapshot bytes remain available throughout the challenge and
grace period, including after a lost acknowledgement or host restart. Durable
server evidence and audit events are not deleted.

Challenge shape, target and current checkout scope are checked before the first
journal write. A MAC-covered validation receipt distinguishes these records from
legacy or unvalidated entries. At capacity, every record is verified before any
unlink; malformed, corrupt, legacy or unexpected files retain the journal for
inspection. File opens refuse symlinks and use nonblocking mode so a FIFO cannot
stall the controller. Retirement and writes fsync the directory. This assumes the
existing single installed-host process lock; it is not a multi-process spool.

Parent validation: 15 collector/journal tests pass, including exact lost-ACK replay,
unexpired/grace retention, expired retirement, invalid MAC, legacy records and a
FIFO with a subprocess deadline. Independent review identified the validation
ordering and FIFO issues; both are covered by the final regressions. Generated
template archives/package checks pass. Continuous collection and production
delivery remain disabled; this proves bounded local spool behavior only.
