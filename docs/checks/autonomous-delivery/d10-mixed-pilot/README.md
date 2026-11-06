# D10 mixed-version pilot

On 2026-11-05, two distinct, locally bundled Hive releases ran concurrently in workerd against the dedicated `hive_d10_pilot` database in the existing Free Neon preview project. The old archive came from revision `24a454c6` and the current archive from `52c4b2e0`. The build readiness input/output hashes were rechecked before use. `result.json` records the source and archive digests, migration plan and durable journal without connection details.

The local-only fixture created a synthetic user, session, project and task. The old app paused the task, the current app read the changed version, then the migration expanded `delivery_tasks` with a pilot identity, marker and dual-write trigger. A bounded backfill backend was terminated after its writes and before commit, matching its PID, backend start, database and fixture application name. The same run was reconstructed; its cursor, row count and checkpoint were unchanged, then three batches completed and full-table integrity passed. Both apps read the expanded schema; the current app resumed the task, the old app observed the new version, and a final query verified the invariant. The evidence stops at `activation_ready`; neither activation nor contraction was performed.

The migration authorizations and deployment observations in this pilot are **local fixtures**. It does not demonstrate the installed GitHub OIDC dispatcher, actual deployment observation, or production rollout. The historical-only smoke used the same archive on both sides. The mixed preflight used both archives without expansion. `mixed-migration.json` is the complete mixed-version migration run.

The isolated database was initialized with 37 migrations: the committed base plus the five listed release migrations; unfinished epic coordination and guardian tree closure migrations were excluded. The dedicated Neon database was reached over its provider endpoint; no existing preview database, live Coder API or production data was used, and no application endpoint was publicly exposed. The app runtime used the restricted `hive_app_runtime` role; the migration used the direct owner connection. Four earlier synthetic tasks from local pilot attempts were present alongside later fixtures; the backfill and integrity query covered the complete pilot table.

For a new disposable pilot, provide separate reviewed old/current archive paths and SHA-256 hashes, a mode-600 runtime URL file and direct owner URL file for a newly created `hive_d10_pilot` database, and a fresh private checkpoint path. The coordinator verifies the database name and Neon host, archive hashes and scope before acting. Its fixed Coder origin is `coder.invalid`; it does not contact Coder. Run from the validation checkout with the three pilot files present:

```sh
HIVE_D10_PILOT_DATABASE_FILE=<private-runtime-url-file> \
HIVE_D10_PILOT_OWNER_FILE=<private-owner-url-file> \
HIVE_D10_PILOT_CHECKPOINT_FILE=<new-private-checkpoint-file> \
HIVE_D10_PILOT_SOURCE_SHA=<current-commit-sha> \
HIVE_D10_PILOT_MIGRATION=true \
HIVE_D10_DELIVERY_REPOSITORY=<committed-primary-repository> \
HIVE_D10_PILOT_OLD_ARCHIVE=<old-archive> \
HIVE_D10_PILOT_NEW_ARCHIVE=<current-archive> \
HIVE_D10_PILOT_OLD_ARCHIVE_SHA256=<old-archive-sha256> \
HIVE_D10_PILOT_NEW_ARCHIVE_SHA256=<current-archive-sha256> \
node deploy/cloudflare/auth/run-d10-pilot.mjs
```

The private checkpoint binds the endpoint, plan and artifacts for recovery; reusing it resumes the recorded run, not a fresh interruption proof. Review the pilot's fixed SQL, role grants, remaining production bindings and the database's provenance before any new run. Archive files and connection files were not copied into this evidence directory.
