import pg from "pg";
import { MigrationHeld, requireValue } from "./contracts.mjs";
/** Direct job-only connection. Never exposed as a model/HTTP argument. Each
 * transaction owns one backend; a timeout closes that backend, not a pool slot. */
export function createMigrationDatabase(databaseUrl) {
  const url = new URL(databaseUrl);
  requireValue(
    ["postgres:", "postgresql:"].includes(url.protocol) &&
      url.hostname &&
      url.pathname.length > 1 &&
      !url.hostname.includes("-pooler.") &&
      !url.searchParams.has("pgbouncer"),
    "migration_direct_connection_required",
  );
  return {
    async $transaction(run, options = {}) {
      const isolation = { Serializable: "SERIALIZABLE", ReadCommitted: "READ COMMITTED" }[
        options.isolationLevel ?? "Serializable"
      ];
      requireValue(
        isolation &&
          Number.isInteger(options.timeout ?? 15000) &&
          (options.timeout ?? 15000) >= 100 &&
          (options.timeout ?? 15000) <= 15000,
        "migration_transaction_budget_invalid",
      );
      const client = new pg.Client({
        connectionString: databaseUrl,
        connectionTimeoutMillis: 2000,
        query_timeout: 6000,
        statement_timeout: 5000,
        idle_in_transaction_session_timeout: 15000,
        application_name: "hive-delivery-migration",
      });
      let closed = false,
        failed = false,
        timer;
      const stop = () => {
        closed = true;
        return client.end().catch(() => {});
      };
      client.on("error", () => {
        failed = true;
      });
      const query = async (sql, values) => {
        requireValue(!closed && !failed, "migration_connection_lost");
        return client.query(sql, values);
      };
      try {
        await client.connect();
        await query(`BEGIN ISOLATION LEVEL ${isolation}`, []);
        const deadline = new Promise((_, reject) => {
          timer = setTimeout(() => {
            void stop();
            reject(new MigrationHeld("migration_transaction_timeout"));
          }, options.timeout ?? 15000);
        });
        const operation = async () => {
          const value = await run({
            async $queryRawUnsafe(sql, ...values) {
              const result = await query(sql, values);
              requireValue(!Array.isArray(result), "migration_query_shape");
              return result.rows;
            },
            async $executeRawUnsafe(sql, ...values) {
              const result = await query(sql, values);
              return Array.isArray(result)
                ? result.reduce((sum, r) => sum + (r.rowCount ?? 0), 0)
                : result.rowCount;
            },
          });
          await query("COMMIT", []);
          return value;
        };
        return await Promise.race([operation(), deadline]);
      } catch (error) {
        if (!closed && !failed) await client.query("ROLLBACK").catch(() => {});
        throw error;
      } finally {
        clearTimeout(timer);
        await stop();
      }
    },
  };
}
