# Private database rehearsal capture

`capture.py` makes a read-only PostgreSQL capture for the F08 migration rehearsal. It does not
restore, upload, run migrations, modify production or change application routing. Keep its output
outside the repository: `source.dump` contains the source data, including encrypted credentials.

The connection URL must be in an owner-only regular file (0600), not an argument or chat message.
The output directory must not exist. For example, from the repository root:

```sh
python3 -B scripts/checks/data-migration/capture.py \
  --connection-file /tmp/hive-epic-coder-auth/production-readonly-url \
  --destination /tmp/hive-private-migration-rehearsal \
  --max-source-bytes 104857600 --max-rows 100000 --timeout-seconds 300
```

Run only after confirming the source identity and read-only access. The tool forces read-only
transactions and rejects inherited libpq connection settings. It holds one exported repeatable-read
snapshot while hashing sorted ordinary table rows and running `pg_dump` against that same snapshot.
Private output files use exclusive creation through a pinned directory descriptor. Source row values
and connection credentials are never printed; CLI output contains counts and archive size only.

The byte limit bounds both the preliminary physical relation-size estimate and actual archive writes.
It does not bound PostgreSQL read I/O or sort temporary space. The shared deadline covers the snapshot,
dump, streamed hashing and manifest publication; child cleanup may take an additional five seconds.
Statement and lock waits also have limits. Failure retains a private partial archive but publishes no
successful capture manifest. Investigate failed attempts rather than reusing their directory.

This version supports ordinary tables in `public` and rejects partitioned, foreign and materialized
relations. Other schemas and large objects are outside its scope. Sequence values are not MVCC
snapshotted: verify them separately during restore. Table fingerprints include duplicates and nulls,
use length-framed SHA-256, and record the column order. They establish row preservation when compared
with a restored copy using the same PostgreSQL representation settings; they do not prove schema,
permissions, secret compatibility, application behavior or backup recoverability.

## Remaining rehearsal steps

1. Inspect the source version, schema objects, migration history, extensions and sequence ownership.
   Confirm the tool's public-schema scope covers the application. Save only sanitized inventory.
2. Capture into a private directory. Verify archive digest and inspect its object list. Treat restored
   SQL as trusted source code; do not restore an unknown backup with elevated credentials.
3. Restore into a newly created, isolated local database first. Keep application jobs, notifications,
   hooks and external effects disabled. Compare all captured table counts and fingerprints before
   applying new migrations, then check schema/constraints/sequences and migration checksums.
4. Apply the epic's existing migration runner to that copy. Compare prior columns and rows again;
   validate new constraints and restricted runtime grants. Exercise the application against the copy
   with synthetic/replaced sessions and outbound effects disabled. Keep raw production data private.
5. Repeat the accepted restore/upgrade path on a separately identified Neon rehearsal target within
   the approved free-tier limits. Record restoration time, integrity results and application checks.
   A local fixture or empty preview upgrade is not a production-data rehearsal.
6. Before the owner's cutover approval, prepare the maintenance-window/write-stop procedure, final
   capture, secret/session transition, route change, observation criteria and rollback decision.
   Routing back to the old database after new writes requires an explicit write-recovery procedure;
   a copied pre-cutover database is not automatically a safe rollback target.

## Local validation

```sh
python3 -B -m unittest discover -s scripts/checks/data-migration -p 'test_*.py'
HIVE_CAPTURE_TEST_PORT=44741 python3 -B -m unittest discover \
  -s scripts/checks/data-migration -p 'test_*.py'
```

The optional integration test uses a local PostgreSQL server as `coder`, creates two uniquely named
fixture databases, and deletes only those databases afterward. It checks a concurrent source insert,
restoration and row hashes, null/duplicate/empty rows, byte/deadline failures, directory replacement
and absence of a success manifest after failure. Do not point it at a production server.
