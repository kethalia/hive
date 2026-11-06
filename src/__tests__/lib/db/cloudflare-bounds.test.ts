import { describe, expect, it, vi } from "vitest";

vi.mock("../../../../packages/db/src/generated/prisma-workerd/client", () => ({
  PrismaClient: class {},
}));

import { createCloudflareDatabaseRequest } from "../../../../packages/db/src/cloudflare";

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
    }).close();
    await createCloudflareDatabaseRequest(undefined, {
      queryTimeoutMillis: 1000,
      transactionTimeoutMillis: 1000,
    }).close();
    await createCloudflareDatabaseRequest(undefined).close();
  });
});
