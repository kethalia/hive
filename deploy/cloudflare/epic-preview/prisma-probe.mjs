import { PrismaNeon } from "@prisma/adapter-neon";
import { PrismaClient } from "./generated/prisma/client.ts";

class DeliberateRollback extends Error {}

export async function probePrisma(url, runId, revision) {
  // The adapter owns a WebSocket pool. Create and disconnect it per request;
  // Worker request contexts cannot share connections with later invocations.
  const client = new PrismaClient({
    adapter: new PrismaNeon({ connectionString: url, max: 1, connectionTimeoutMillis: 10_000 }),
    transactionOptions: { maxWait: 10_000, timeout: 15_000 },
  });
  const payload = { probe: "f02", revision, driver: "prisma-neon-websocket" };
  const where = { runId_phase: { runId, phase: "commit" } };
  const commit = () =>
    client.$transaction(async (tx) => {
      // Deliberately await the read before choosing the next query: this cannot
      // be represented as an HTTP noninteractive array-of-queries transaction.
      const before = await tx.probe.findUnique({ where });
      const inserted = await tx.probe.createMany({
        data: [{ runId, phase: "commit", payload }],
        skipDuplicates: true,
      });
      const after = await tx.probe.findUnique({ where });
      return { existed: before !== null, inserted: inserted.count, row: after };
    });
  try {
    const [permissions] = await client.$queryRaw`SELECT
      has_schema_privilege(current_user, 'hive_epic_preview', 'CREATE') AS "schemaCreate",
      has_table_privilege(current_user, 'hive_epic_preview.probes', 'SELECT') AS "tableSelect",
      has_table_privilege(current_user, 'hive_epic_preview.probes', 'INSERT') AS "tableInsert",
      has_table_privilege(current_user, 'hive_epic_preview.probes', 'UPDATE') AS "tableUpdate",
      has_table_privilege(current_user, 'hive_epic_preview.probes', 'DELETE') AS "tableDelete"`;
    if (
      permissions.schemaCreate ||
      !permissions.tableSelect ||
      !permissions.tableInsert ||
      permissions.tableUpdate ||
      permissions.tableDelete
    )
      throw new Error("Preview runtime role is not restricted");
    const first = await commit();
    const second = await commit();
    let rolledBack = false;
    try {
      await client.$transaction(async (tx) => {
        await tx.probe.create({ data: { runId, phase: "rollback", payload } });
        const within = await tx.probe.findUnique({
          where: { runId_phase: { runId, phase: "rollback" } },
        });
        if (!within) throw new Error("Inserted rollback row was not visible inside transaction");
        throw new DeliberateRollback("Test callback requests rollback");
      });
    } catch (error) {
      if (!(error instanceof DeliberateRollback)) throw error;
      rolledBack = true;
    }
    const rows = await client.probe.findMany({ where: { runId }, orderBy: { phase: "asc" } });
    const committed = (row) =>
      row?.phase === "commit" &&
      row.payload?.probe === "f02" &&
      row.payload?.revision === revision &&
      row.createdAt instanceof Date &&
      Number.isFinite(row.createdAt.getTime());
    if (
      !committed(first.row) ||
      !committed(second.row) ||
      second.inserted !== 0 ||
      !second.existed ||
      first.inserted > 1 ||
      !rolledBack ||
      rows.length !== 1 ||
      !committed(rows[0])
    )
      throw new Error("Interactive transaction invariant failed");
    return {
      prismaVersion: "6.19.3",
      generatorRuntime: "workerd",
      engine: "client",
      transport: "neon-websocket",
      transactionKind: "interactive-callback",
      committed: true,
      duplicateReplay: true,
      rollback: true,
      insertedThisRun: first.inserted === 1,
      retainedRowsForRun: rows.length,
      uuidAndJsonRoundTrip: true,
      timestampRoundTrip: true,
      runtimeRoleRestricted: true,
      fullHiveSchemaVerified: false,
      frameworkVerified: false,
    };
  } finally {
    await client.$disconnect();
  }
}
