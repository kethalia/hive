import {
  authorizeReceipt,
  decimal,
  deploymentReceipt,
  digest,
  MigrationHeld,
  requireValue,
  validatePlan,
  validateScope,
} from "./contracts.mjs";
import { acquirePrismaInteroperabilityLock, assertPrismaLockContract } from "./prisma-lock.mjs";

const phases = {
  expand: "pending",
  compatible: "expanded",
  backfill: "compatible",
  integrity: "backfilled",
  activate: "verified",
  contract: "activated",
};
const done = {
  expand: "expanded",
  compatible: "compatible",
  backfill: "backfilled",
  integrity: "verified",
  activate: "activated",
  contract: "contract_held",
};
const bounded = (rows) => {
  requireValue(Buffer.byteLength(JSON.stringify(rows)) <= 131072, "migration_observation_limit");
  return rows;
};
const clock = async (tx) =>
  (
    await tx.$queryRawUnsafe(
      "SELECT (extract(epoch FROM clock_timestamp())*1000)::bigint::text AS now",
    )
  )[0].now;
const stopped = (signal) => requireValue(!signal?.aborted, "migration_interrupted");
async function boundedCallback(callback, signal) {
  const cancel = new AbortController();
  let timer, abort;
  try {
    const interrupted = new Promise((_, reject) => {
      abort = () => {
        cancel.abort();
        reject(new MigrationHeld("migration_interrupted"));
      };
      signal?.addEventListener("abort", abort, { once: true });
      timer = setTimeout(() => {
        cancel.abort();
        reject(new MigrationHeld("migration_authority_timeout"));
      }, 5000);
      if (signal?.aborted) abort();
    });
    return await Promise.race([Promise.resolve().then(() => callback(cancel.signal)), interrupted]);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
    cancel.abort();
  }
}
/** One transaction/batch per tick. The caller supplies a controller-authenticated
 * catalog, direct target connection and independent authority; no CLI/HTTP/model
 * request accepts SQL, credentials, policy or a replacement schema fingerprint. */
export function createDeliveryMigrationController({
  enabled = false,
  db,
  scope: rawScope,
  plan: rawPlan,
  expectedPlanDigest,
  authorize,
  observeDeployment,
  prepareDeployment,
  refreshActivationIntegrity = false,
}) {
  requireValue(enabled === true, "migration_disabled");
  assertPrismaLockContract();
  const scope = validateScope(rawScope),
    plan = validatePlan(rawPlan),
    scopeDigest = digest(scope),
    planDigest = digest(plan);
  requireValue(
    planDigest === expectedPlanDigest && typeof authorize === "function",
    "migration_catalog_unverified",
  );
  async function authority(tx, runId, action, signal) {
    stopped(signal);
    const receipt = await boundedCallback(
      (boundedSignal) =>
        authorize({
          tx,
          scope: structuredClone(scope),
          planDigest,
          runId,
          action,
          signal: boundedSignal,
        }),
      signal,
    );
    stopped(signal);
    return authorizeReceipt(
      receipt,
      { scopeDigest, planDigest, runId, action },
      Number(await clock(tx)),
    );
  }
  async function schema(tx) {
    return digest(bounded(await tx.$queryRawUnsafe(plan.schemaSql)));
  }
  async function locked(tx) {
    const current = (await tx.$queryRawUnsafe("SELECT current_database() AS name"))[0];
    requireValue(current.name === scope.databaseName, "migration_database_changed");
    await acquirePrismaInteroperabilityLock(tx);
    const databaseLock = (
      await tx.$queryRawUnsafe(
        "SELECT pg_try_advisory_xact_lock(1212765765,1145192786) AS acquired",
      )
    )[0];
    requireValue(databaseLock.acquired, "migration_database_busy");
    const key = BigInt.asIntN(64, BigInt(`0x${digest(scope.targetId).slice(0, 16)}`));
    const lock = (
      await tx.$queryRawUnsafe(
        "SELECT pg_try_advisory_xact_lock($1::bigint) AS acquired",
        key.toString(),
      )
    )[0];
    requireValue(lock.acquired, "migration_target_busy");
    await tx.$executeRawUnsafe(
      "SELECT set_config('statement_timeout',$1,true)",
      `${plan.statementTimeoutMs}ms`,
    );
    await tx.$executeRawUnsafe(
      "SELECT set_config('lock_timeout',$1,true)",
      `${plan.lockTimeoutMs}ms`,
    );
  }
  async function transaction(runId, action, signal, run) {
    stopped(signal);
    return db.$transaction(
      async (tx) => {
        await locked(tx);
        const before = await authority(tx, runId, action, signal);
        const result = await run(tx);
        const after = await authority(tx, runId, action, signal);
        const end = Number(await clock(tx));
        requireValue(
          before.expiresAt > end && after.expiresAt > end,
          "migration_authority_unavailable",
        );
        if (["compatible", "activate", "certificate"].includes(action)) {
          const recorded = await load(tx, runId);
          const observation =
            action === "compatible"
              ? recorded.compatibility
              : action === "activate"
                ? recorded.activation
                : null;
          if (observation)
            requireValue(observation.expiresAt > end, "migration_deployment_receipt_stale");
          if (result.kind === "database_compatibility_observation")
            requireValue(result.expiresAt > end, "migration_deployment_receipt_stale");
        }
        if (result.kind === "database_compatibility_observation")
          result.expiresAt = Math.min(result.expiresAt, before.expiresAt, after.expiresAt);
        return result;
      },
      {
        isolationLevel: ["integrity", "activate", "certificate"].includes(action)
          ? "ReadCommitted"
          : "Serializable",
        timeout: 15000,
        maxWait: 2000,
      },
    );
  }
  async function append(tx, row, kind, patch, payload) {
    const version = row.version + 1,
      checkpoint = digest({ previous: row.checkpoint_digest, version, kind, payload });
    await tx.$executeRawUnsafe(
      "INSERT INTO hive_delivery_db.events(run_id,version,kind,payload,digest) VALUES($1::uuid,$2,$3,$4::jsonb,$5)",
      row.id,
      version,
      kind,
      JSON.stringify(payload),
      checkpoint,
    );
    const updated = await tx.$executeRawUnsafe(
      "UPDATE hive_delivery_db.runs SET phase=$2,version=$3,cursor=$4::bigint,high_water=$5::bigint,changed_rows=$6::bigint,checkpoint_digest=$7,compatibility=$8::jsonb,integrity=$9::jsonb,activation=$10::jsonb,updated_at=clock_timestamp() WHERE id=$1::uuid AND version=$11",
      row.id,
      patch.phase ?? row.phase,
      version,
      patch.cursor ?? row.cursor,
      patch.high_water ?? row.high_water,
      patch.changed_rows ?? row.changed_rows,
      checkpoint,
      JSON.stringify(patch.compatibility ?? row.compatibility),
      JSON.stringify(patch.integrity ?? row.integrity),
      JSON.stringify(patch.activation ?? row.activation),
      row.version,
    );
    requireValue(updated === 1, "migration_checkpoint_conflict");
    return { ...row, ...patch, version, checkpoint_digest: checkpoint };
  }
  function result(row) {
    return {
      runId: row.id,
      phase: row.phase,
      version: row.version,
      cursor: row.cursor,
      highWater: row.high_water,
      changedRows: row.changed_rows,
      checkpointDigest: row.checkpoint_digest,
      planDigest,
      scopeDigest,
      sourceSha: plan.sourceSha,
      beforeSchemaDigest: plan.beforeSchemaDigest,
      afterSchemaDigest: plan.afterSchemaDigest,
      oldAppDigest: plan.oldAppDigest,
      newAppDigest: plan.newAppDigest,
      compatibilityDigest: plan.compatibilityDigest,
      compatibilityReceiptDigest: row.compatibility?.receiptDigest ?? null,
      integrity: row.integrity ?? null,
      activationReceiptDigest: row.activation?.receiptDigest ?? null,
      contractAuthorized: false,
      executionAuthorized: false,
    };
  }
  async function load(tx, runId) {
    const target = (
      await tx.$queryRawUnsafe(
        "SELECT * FROM hive_delivery_db.targets WHERE target_id=$1::uuid FOR UPDATE",
        scope.targetId,
      )
    )[0];
    requireValue(
      target && target.scope_digest === scopeDigest && target.current_run === runId,
      "migration_target_generation_changed",
    );
    const row = (
      await tx.$queryRawUnsafe(
        "SELECT *,cursor::text AS cursor,high_water::text AS high_water,changed_rows::text AS changed_rows FROM hive_delivery_db.runs WHERE id=$1::uuid FOR UPDATE",
        runId,
      )
    )[0];
    requireValue(
      row &&
        row.target_id === scope.targetId &&
        row.scope_digest === scopeDigest &&
        row.plan_digest === planDigest &&
        digest(row.plan) === planDigest,
      "migration_run_changed",
    );
    if (row.version) {
      const event = (
        await tx.$queryRawUnsafe(
          "SELECT digest FROM hive_delivery_db.events WHERE run_id=$1::uuid AND version=$2",
          runId,
          row.version,
        )
      )[0];
      requireValue(event?.digest === row.checkpoint_digest, "migration_checkpoint_changed");
    }
    return row;
  }
  return {
    async begin(runId, { signal } = {}) {
      requireValue(
        typeof runId === "string" &&
          /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(runId),
        "migration_run_invalid",
      );
      return transaction(runId, "begin", signal, async (tx) => {
        await tx.$executeRawUnsafe(
          "INSERT INTO hive_delivery_db.targets(target_id,scope,scope_digest) VALUES($1::uuid,$2::jsonb,$3) ON CONFLICT DO NOTHING",
          scope.targetId,
          JSON.stringify(scope),
          scopeDigest,
        );
        const target = (
          await tx.$queryRawUnsafe(
            "SELECT * FROM hive_delivery_db.targets WHERE target_id=$1::uuid FOR UPDATE",
            scope.targetId,
          )
        )[0];
        requireValue(target.scope_digest === scopeDigest && digest(target.scope) === scopeDigest);
        if (target.current_run === runId) return result(await load(tx, runId));
        if (target.current_run) {
          const old = (
            await tx.$queryRawUnsafe(
              "SELECT phase FROM hive_delivery_db.runs WHERE id=$1::uuid",
              target.current_run,
            )
          )[0];
          requireValue(
            ["activated", "contract_held"].includes(old?.phase),
            "migration_previous_run_pending",
          );
        }
        requireValue(
          (await schema(tx)) === plan.beforeSchemaDigest,
          "migration_schema_before_changed",
        );
        await tx.$executeRawUnsafe(
          "INSERT INTO hive_delivery_db.runs(id,target_id,scope_digest,plan_digest,plan,phase,checkpoint_digest) VALUES($1::uuid,$2::uuid,$3,$4,$5::jsonb,'pending',$6)",
          runId,
          scope.targetId,
          scopeDigest,
          planDigest,
          JSON.stringify(plan),
          digest({ runId, scopeDigest, planDigest }),
        );
        await tx.$executeRawUnsafe(
          "UPDATE hive_delivery_db.targets SET current_run=$2::uuid,generation=generation+1 WHERE target_id=$1::uuid",
          scope.targetId,
          runId,
        );
        return result(await load(tx, runId));
      });
    },
    async tick(runId, action, { signal } = {}) {
      requireValue(Object.hasOwn(phases, action), "migration_action_unsupported");
      if (prepareDeployment && ["compatible", "activate"].includes(action))
        await prepareDeployment({ runId, action, signal });
      return transaction(runId, action, signal, async (tx) => {
        let row = await load(tx, runId);
        if (["integrity", "activate"].includes(action)) await fenceIntegrity(tx);
        if (row.phase === done[action]) {
          requireValue(
            (await schema(tx)) === plan.afterSchemaDigest,
            "migration_schema_after_changed",
          );
          return result(row);
        }
        requireValue(row.phase === phases[action], "migration_dependency_pending");
        requireValue(
          (await schema(tx)) ===
            (action === "expand" ? plan.beforeSchemaDigest : plan.afterSchemaDigest),
          "migration_schema_changed",
        );
        stopped(signal);
        if (action === "expand") {
          for (const statement of plan.expandSql) {
            await tx.$executeRawUnsafe(statement);
            stopped(signal);
          }
          requireValue(
            (await schema(tx)) === plan.afterSchemaDigest,
            "migration_schema_expansion_mismatch",
          );
          const high = bounded(await tx.$queryRawUnsafe(plan.highWaterSql));
          requireValue(high.length === 1, "migration_high_water_invalid");
          decimal(high[0].high_water);
          row = await append(
            tx,
            row,
            action,
            { phase: "expanded", high_water: high[0].high_water },
            { schemaDigest: plan.afterSchemaDigest, highWater: high[0].high_water },
          );
        } else if (action === "compatible" || action === "activate") {
          requireValue(
            typeof observeDeployment === "function",
            "migration_deployment_observer_unavailable",
          );
          const expected = {
            kind: action,
            targetId: scope.targetId,
            runId,
            sourceSha: plan.sourceSha,
            planDigest,
            schemaDigest: plan.afterSchemaDigest,
            oldAppDigest: plan.oldAppDigest,
            newAppDigest: plan.newAppDigest,
            compatibilityDigest: plan.compatibilityDigest,
          };
          if (action === "activate") await verifyIntegrity(tx);
          const observed = await boundedCallback(
            (boundedSignal) =>
              observeDeployment({
                tx,
                expected: structuredClone(expected),
                signal: boundedSignal,
              }),
            signal,
          );
          stopped(signal);
          deploymentReceipt(observed, expected, Number(await clock(tx)));
          const activationIntegrity = action === "activate" ? await verifyIntegrity(tx) : null;
          row = await append(
            tx,
            row,
            action,
            {
              phase: done[action],
              [action === "compatible" ? "compatibility" : "activation"]: observed,
              ...(refreshActivationIntegrity && activationIntegrity
                ? { integrity: activationIntegrity }
                : {}),
            },
            { receiptDigest: observed.receiptDigest },
          );
        } else if (action === "backfill") {
          const rows = bounded(
            await tx.$queryRawUnsafe(plan.batchSql, row.cursor, row.high_water, plan.batchSize),
          );
          stopped(signal);
          requireValue(rows.length <= plan.batchSize, "migration_batch_limit");
          let cursor = decimal(row.cursor);
          const high = decimal(row.high_water);
          for (const value of rows) {
            const key = decimal(value.key);
            requireValue(key > cursor && key <= high, "migration_batch_cursor_changed");
            cursor = key;
          }
          if (!rows.length) cursor = high;
          const cursorText = cursor.toString();
          row = await append(
            tx,
            row,
            action,
            {
              phase: cursor === high ? "backfilled" : "compatible",
              cursor: cursorText,
              changed_rows: (BigInt(row.changed_rows) + BigInt(rows.length)).toString(),
            },
            {
              before: row.cursor,
              after: cursorText,
              rowCount: rows.length,
              keysDigest: digest(rows),
            },
          );
        } else if (action === "integrity") {
          const observed = await verifyIntegrity(tx);
          row = await append(tx, row, action, { phase: "verified", integrity: observed }, observed);
        } else if (action === "contract") {
          row = await append(
            tx,
            row,
            action,
            { phase: "contract_held" },
            { reason: "destructive_contraction_requires_separate_reviewed_authority" },
          );
        }
        return result(row);
      });
    },
    async certificate(runId, { signal } = {}) {
      if (prepareDeployment) await prepareDeployment({ runId, action: "certificate", signal });
      return transaction(runId, "certificate", signal, async (tx) => {
        const row = await load(tx, runId);
        await fenceIntegrity(tx);
        requireValue(
          ["verified", "activated", "contract_held"].includes(row.phase),
          "migration_integrity_pending",
        );
        requireValue((await schema(tx)) === plan.afterSchemaDigest, "migration_schema_changed");
        const integrity = await verifyIntegrity(tx);
        requireValue(
          typeof observeDeployment === "function",
          "migration_deployment_observer_unavailable",
        );
        const expected = {
          kind: "compatible",
          targetId: scope.targetId,
          runId,
          sourceSha: plan.sourceSha,
          planDigest,
          schemaDigest: plan.afterSchemaDigest,
          oldAppDigest: plan.oldAppDigest,
          newAppDigest: plan.newAppDigest,
          compatibilityDigest: plan.compatibilityDigest,
        };
        const receipt = await boundedCallback(
          (signal) => observeDeployment({ tx, expected, purpose: "certificate", signal }),
          signal,
        );
        const now = Number(await clock(tx));
        deploymentReceipt(receipt, expected, now);
        return {
          ...result(row),
          kind: "database_compatibility_observation",
          scope: structuredClone(scope),
          integrity,
          observedAt: now,
          expiresAt: Math.min(receipt.expiresAt, now + 30000),
          compatibilityReceiptDigest: receipt.receiptDigest,
          activationAuthorized: false,
        };
      });
    },
    async read(runId, { signal } = {}) {
      return transaction(runId, "read", signal, async (tx) => result(await load(tx, runId)));
    },
  };
  async function fenceIntegrity(tx) {
    const tables = plan.integrityTables.map((t) => `"${t.schema}"."${t.name}"`).sort();
    await tx.$executeRawUnsafe(`LOCK TABLE ${tables.join(",")} IN SHARE MODE`);
  }
  async function verifyIntegrity(tx) {
    const rows = bounded(await tx.$queryRawUnsafe(plan.integritySql));
    requireValue(rows.length === 1, "migration_integrity_shape");
    const { violations, total_rows } = rows[0];
    decimal(violations);
    decimal(total_rows);
    requireValue(violations === "0", "migration_integrity_failed");
    return {
      violations,
      totalRows: total_rows,
      queryDigest: digest(plan.integritySql),
      schemaDigest: await schema(tx),
    };
  }
}
export { MigrationHeld };
