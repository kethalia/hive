import type { PrismaClient } from "@hive/db";
import { createDatabaseRequest, getDb } from "@hive/db";
import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => vi.unstubAllEnvs());
const fixture = () => {
  const disconnect = vi.fn(async () => {});
  return { client: { $disconnect: disconnect } as unknown as PrismaClient, disconnect };
};

describe("database request isolation", () => {
  it("lazily creates and closes one client per request, without a Worker singleton fallback", async () => {
    vi.stubEnv("HIVE_RUNTIME_TARGET", "cloudflare");
    const { client, disconnect } = fixture();
    const create = vi.fn(() => client);
    const request = createDatabaseRequest(create);
    await request.run(async () => {
      expect(create).not.toHaveBeenCalled();
      expect(getDb()).toBe(client);
      await Promise.resolve();
      expect(getDb()).toBe(client);
    });
    expect(create).toHaveBeenCalledTimes(1);
    await request.close();
    await request.close();
    expect(disconnect).toHaveBeenCalledTimes(1);
    expect(() => request.run(() => getDb())).toThrow("context is closed");
    expect(() => getDb()).toThrow("request context is missing");
  });

  it("isolates interleaved asynchronous requests and closes unused requests without opening a connection", async () => {
    vi.stubEnv("HIVE_RUNTIME_TARGET", "cloudflare");
    const first = fixture();
    const second = fixture();
    const a = createDatabaseRequest(() => first.client);
    const b = createDatabaseRequest(() => second.client);
    let resume!: () => void;
    const gate = new Promise<void>((resolve) => {
      resume = resolve;
    });
    const pending = a.run(async () => {
      expect(getDb()).toBe(first.client);
      await gate;
      expect(getDb()).toBe(first.client);
    });
    await b.run(async () => {
      expect(getDb()).toBe(second.client);
      resume();
      await pending;
      expect(getDb()).toBe(second.client);
    });
    await Promise.all([a.close(), b.close()]);
    const unused = vi.fn(() => first.client);
    await createDatabaseRequest(unused).close();
    expect(unused).not.toHaveBeenCalled();
  });

  it("shares request context across separately bundled module copies", async () => {
    const { client } = fixture();
    const request = createDatabaseRequest(() => client);
    vi.resetModules();
    const otherCopy = await import("../../../../packages/db/src/request-scope");
    request.run(() => expect(otherCopy.getRequestDb()).toBe(client));
    await request.close();
  });
});
