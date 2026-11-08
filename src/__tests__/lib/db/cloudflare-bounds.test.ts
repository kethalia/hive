import { describe, expect, it, vi } from "vitest";

vi.mock("../../../../packages/db/src/generated/prisma-workerd/client", () => ({
  PrismaClient: class {
    constructor(public options: unknown) {}
    $disconnect = vi.fn(async () => {});
  },
}));

import { createCloudflareDatabaseRequest } from "../../../../packages/db/src/cloudflare";
import {
  captureRequestDatabaseFactory,
  getRequestDb,
} from "../../../../packages/db/src/request-scope";

describe("optional request-local server and driver query bounds", () => {
  it.each([
    0,
    -1,
    10001,
    0.5,
    NaN,
    Infinity,
  ])("rejects invalid server limit %s before allocating a client", (value) => {
    expect(() =>
      createCloudflareDatabaseRequest(undefined, {
        queryTimeoutMillis: 10000,
        transactionTimeoutMillis: 10000,
        statementTimeoutMillis: value,
      }),
    ).toThrow("Invalid request-local timeout");
  });
  it.each([
    0,
    -1,
    10001,
    0.5,
    NaN,
    Infinity,
  ])("rejects invalid connection bound %s before allocating a client", (value) => {
    expect(() =>
      createCloudflareDatabaseRequest(undefined, {
        queryTimeoutMillis: 1000,
        transactionTimeoutMillis: 1000,
        connectionTimeoutMillis: value,
      }),
    ).toThrow("Invalid request-local timeout");
  });
  it("permits only a server bound no weaker than the driver deadline", async () => {
    expect(() =>
      createCloudflareDatabaseRequest(undefined, {
        queryTimeoutMillis: 1000,
        transactionTimeoutMillis: 1000,
        statementTimeoutMillis: 1001,
      }),
    ).toThrow();
    await createCloudflareDatabaseRequest(undefined, {
      queryTimeoutMillis: 1000,
      transactionTimeoutMillis: 1000,
      statementTimeoutMillis: 100,
      connectionTimeoutMillis: 2500,
    }).close();
    await createCloudflareDatabaseRequest(undefined, {
      queryTimeoutMillis: 1000,
      transactionTimeoutMillis: 1000,
    }).close();
    await createCloudflareDatabaseRequest(undefined).close();
  });
});

describe("bound background factory", () => {
  it("binds concurrent captured factories to their original URLs and allocates new bounded pools", async () => {
    const a = createCloudflareDatabaseRequest("postgresql://fixture-a@127.0.0.1:1/fixture_a"),
      b = createCloudflareDatabaseRequest("postgresql://fixture-b@127.0.0.1:1/fixture_b");
    let resume!: () => void;
    const gate = new Promise<void>((resolve) => {
      resume = resolve;
    });
    const [first, second] = await Promise.all([
      a.run(async () => {
        const factory = captureRequestDatabaseFactory();
        await gate;
        expect(captureRequestDatabaseFactory()).toBe(factory);
        return factory;
      }),
      b.run(async () => {
        resume();
        return captureRequestDatabaseFactory();
      }),
    ]);
    await Promise.all([a.close(), b.close()]);
    const bounds = {
      queryTimeoutMillis: 2500,
      connectionTimeoutMillis: 2500,
      transactionTimeoutMillis: 5000,
    };
    const firstSibling = first!(bounds),
      secondSibling = second!(bounds);
    const clients = [
      firstSibling.run(getRequestDb),
      secondSibling.run(getRequestDb),
    ] as unknown as {
      options: {
        adapter: {
          connect(): Promise<{
            underlyingDriver(): {
              options: {
                connectionString: string;
                connectionTimeoutMillis: number;
                query_timeout: number;
              };
            };
            dispose(): Promise<void>;
          }>;
        };
        transactionOptions: { maxWait: number; timeout: number };
      };
      $disconnect: ReturnType<typeof vi.fn>;
    }[];
    expect(clients[0]).not.toBe(clients[1]);
    const adapters = await Promise.all(clients.map((client) => client.options.adapter.connect()));
    expect(adapters.map((adapter) => adapter.underlyingDriver().options.connectionString)).toEqual([
      "postgresql://fixture-a@127.0.0.1:1/fixture_a",
      "postgresql://fixture-b@127.0.0.1:1/fixture_b",
    ]);
    for (const [index, client] of clients.entries()) {
      expect(adapters[index].underlyingDriver().options).toMatchObject({
        connectionTimeoutMillis: 2500,
        query_timeout: 2500,
      });
      expect(client.options.transactionOptions).toEqual({ maxWait: 5000, timeout: 5000 });
      expect(client.$disconnect).not.toHaveBeenCalled();
    }
    await Promise.all([
      firstSibling.close(),
      secondSibling.close(),
      ...adapters.map((adapter) => adapter.dispose()),
    ]);
    for (const client of clients) expect(client.$disconnect).toHaveBeenCalledTimes(1);
  });
});
