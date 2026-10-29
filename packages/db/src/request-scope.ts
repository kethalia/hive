import { AsyncLocalStorage } from "node:async_hooks";
import type { PrismaClient } from "./generated/prisma/client";

type RequestDatabase = { create: () => PrismaClient; client?: PrismaClient; closed: boolean };
const STORE = Symbol.for("hive.database.request-context.v1");
// OpenNext and the custom Worker can bundle this module separately. Sharing the
// ALS instance, rather than a client, preserves one request boundary across them.
const globalStore = globalThis as typeof globalThis & {
  [STORE]?: AsyncLocalStorage<RequestDatabase>;
};
if (!globalStore[STORE]) globalStore[STORE] = new AsyncLocalStorage<RequestDatabase>();
const storage = globalStore[STORE];

export function getRequestDb(): PrismaClient | undefined {
  const context = storage.getStore();
  if (!context) return undefined;
  if (context.closed) throw new Error("Database request context is closed");
  context.client ??= context.create();
  return context.client;
}

export function createDatabaseRequest(create: () => PrismaClient) {
  const context: RequestDatabase = { create, closed: false };
  return {
    run<T>(operation: () => T): T {
      return storage.run(context, operation);
    },
    async close() {
      if (context.closed) return;
      context.closed = true;
      await context.client?.$disconnect();
    },
  };
}
