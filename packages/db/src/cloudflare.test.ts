import { afterEach, describe, expect, it, vi } from "vitest";
import { createCloudflareDatabaseRequest } from "./cloudflare";
import { getDb } from "./index";
import { captureRequestDatabaseFactory } from "./request-scope";

const { adapterOptions, clientOptions, disconnect } = vi.hoisted(() => ({
  adapterOptions: vi.fn(),
  clientOptions: vi.fn(),
  disconnect: vi.fn(async () => {}),
}));

vi.mock("@prisma/adapter-neon", () => ({
  PrismaNeon: class {
    constructor(options: unknown) {
      adapterOptions(options);
    }
  },
}));
vi.mock("./generated/prisma-workerd/client", () => ({
  PrismaClient: class {
    constructor(options: unknown) {
      clientOptions(options);
    }
    $disconnect = disconnect;
  },
}));

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});

describe("Cloudflare database adapter", () => {
  it("opens one request-local connection lazily with the original URL and requested bounds", async () => {
    vi.stubEnv("HIVE_RUNTIME_TARGET", "cloudflare");
    const url = "postgresql://fixture:fixture@database.invalid/hive_fixture";
    const request = createCloudflareDatabaseRequest(url, {
      queryTimeoutMillis: 2500,
      statementTimeoutMillis: 2000,
      transactionTimeoutMillis: 5000,
      connectionTimeoutMillis: 1500,
    });
    expect(adapterOptions).not.toHaveBeenCalled();
    request.run(() => {
      expect(getDb()).toBe(getDb());
    });
    expect(adapterOptions).toHaveBeenCalledExactlyOnceWith({
      connectionString: url,
      max: 1,
      connectionTimeoutMillis: 1500,
      query_timeout: 2500,
      statement_timeout: 2000,
    });
    expect(clientOptions).toHaveBeenCalledWith({
      adapter: expect.anything(),
      transactionOptions: { maxWait: 5000, timeout: 5000 },
    });
    await request.close();
    expect(disconnect).toHaveBeenCalledOnce();
  });

  it("retains the parent URL for independent siblings and never rereads ambient credentials", async () => {
    vi.stubEnv("HIVE_RUNTIME_TARGET", "cloudflare");
    const url = "postgresql://fixture:fixture@original.invalid/hive_fixture";
    const parent = createCloudflareDatabaseRequest(url);
    const factory = parent.run(captureRequestDatabaseFactory)!;
    await parent.close();
    vi.stubEnv("DATABASE_URL", "postgresql://other:other@foreign.invalid/foreign");
    const sibling = factory({ queryTimeoutMillis: 1000, transactionTimeoutMillis: 2000 });
    sibling.run(getDb);
    expect(adapterOptions).toHaveBeenCalledWith(expect.objectContaining({ connectionString: url }));
    await sibling.close();
  });

  it("rejects invalid timeout bounds before opening a connection", () => {
    for (const queryTimeoutMillis of [0, -1, 1.5, Number.NaN, 10001]) {
      expect(() =>
        createCloudflareDatabaseRequest("fixture", {
          queryTimeoutMillis,
          transactionTimeoutMillis: 1000,
        }),
      ).toThrow("Invalid request-local timeout bounds");
    }
    expect(() =>
      createCloudflareDatabaseRequest("fixture", {
        queryTimeoutMillis: 1000,
        statementTimeoutMillis: 1001,
        transactionTimeoutMillis: 1000,
      }),
    ).toThrow("Invalid request-local timeout bounds");
    expect(adapterOptions).not.toHaveBeenCalled();
  });
});
