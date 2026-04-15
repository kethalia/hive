import { randomUUID } from "node:crypto";
import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { getPool, closePool } from "../src/db.js";
import { ScrollbackWriter } from "../src/scrollback-writer.js";

const DATABASE_URL = process.env.DATABASE_URL;

describe.skipIf(!DATABASE_URL)(
  "ScrollbackWriter integration (real Postgres)",
  () => {
    const testReconnectIds: string[] = [];
    let pool: ReturnType<typeof getPool>;

    beforeAll(() => {
      pool = getPool();
    });

    afterEach(async () => {
      for (const rid of testReconnectIds) {
        await pool`DELETE FROM scrollback_chunks WHERE reconnect_id = ${rid}`;
      }
      testReconnectIds.length = 0;
    });

    afterAll(async () => {
      await closePool();
    });

    it("write→read: chunks appear with correct seqNum ordering and data", async () => {
      const reconnectId = randomUUID();
      testReconnectIds.push(reconnectId);

      const writer = new ScrollbackWriter({
        reconnectId,
        agentId: randomUUID(),
        sessionName: "test-session",
        pool,
        flushIntervalMs: 60_000,
        sizeThreshold: 1024 * 1024,
      });

      writer.append(Buffer.from("hello "));
      await writer.flush();

      writer.append(Buffer.from("world"));
      await writer.flush();
      await writer.close();

      const rows =
        await pool`SELECT reconnect_id, seq_num, data, byte_size FROM scrollback_chunks WHERE reconnect_id = ${reconnectId} ORDER BY seq_num ASC`;

      expect(rows).toHaveLength(2);
      expect(rows[0].seq_num).toBe(0);
      expect(rows[1].seq_num).toBe(1);
      expect(Buffer.from(rows[0].data).toString()).toBe("hello ");
      expect(Buffer.from(rows[1].data).toString()).toBe("world");
    });

    it("multiple flushes produce monotonically increasing seqNums", async () => {
      const reconnectId = randomUUID();
      testReconnectIds.push(reconnectId);

      const writer = new ScrollbackWriter({
        reconnectId,
        agentId: randomUUID(),
        sessionName: "test-multi-flush",
        pool,
        flushIntervalMs: 60_000,
        sizeThreshold: 1024 * 1024,
      });

      for (let i = 0; i < 5; i++) {
        writer.append(Buffer.from(`batch-${i}`));
        await writer.flush();
      }
      await writer.close();

      const rows =
        await pool`SELECT seq_num FROM scrollback_chunks WHERE reconnect_id = ${reconnectId} ORDER BY seq_num ASC`;

      expect(rows).toHaveLength(5);
      for (let i = 0; i < 5; i++) {
        expect(rows[i].seq_num).toBe(i);
      }
    });

    it("byteSize matches actual data length", async () => {
      const reconnectId = randomUUID();
      testReconnectIds.push(reconnectId);

      const writer = new ScrollbackWriter({
        reconnectId,
        agentId: randomUUID(),
        sessionName: "test-bytesize",
        pool,
        flushIntervalMs: 60_000,
        sizeThreshold: 1024 * 1024,
      });

      const payload = Buffer.alloc(1024, 0xab);
      writer.append(payload);
      await writer.flush();
      await writer.close();

      const rows =
        await pool`SELECT byte_size, data FROM scrollback_chunks WHERE reconnect_id = ${reconnectId}`;

      expect(rows).toHaveLength(1);
      expect(rows[0].byte_size).toBe(1024);
      expect(Buffer.from(rows[0].data).byteLength).toBe(1024);
    });
  },
);
