import { randomUUID } from "node:crypto";
import { PrismaClient } from "@hive/db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  LEGACY_TOKEN_LIFETIME_MS,
  LEGACY_TOKEN_ROTATION_WINDOW_MS,
} from "@/lib/queue/token-rotation-cloudflare.server";

const mocks = vi.hoisted(() => ({ wake: vi.fn(), cleanup: vi.fn() }));
vi.mock("@hive/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@hive/db")>()),
  getDb: () => db,
}));
vi.mock("@hive/db/cloudflare", () => ({
  createCloudflareDatabaseRequest: () => ({
    run: (operation: () => unknown) => operation(),
    close: async () => {},
  }),
}));
vi.mock("@/lib/queue/background-wake.server", () => ({ wakeBackground: mocks.wake }));
vi.mock("@/lib/terminal/diagnostics.server", () => ({
  cleanupTerminalDiagnostics: mocks.cleanup,
}));

import {
  type BackgroundEnvironment,
  nextBackgroundAt,
  repairBackground,
} from "../../../deploy/cloudflare/native/background";

const connection = process.env.HIVE_ROTATION_PARITY_TEST_DATABASE_URL;
if (connection) {
  const url = new URL(connection);
  if (
    url.hostname !== "127.0.0.1" ||
    url.port !== "55439" ||
    url.username !== "coder" ||
    url.pathname !== "/hive_rotation_parity_test_20261113"
  )
    throw Error("Owned local background scheduling fixture required");
}
const db = new PrismaClient({
  datasourceUrl: connection ?? "postgresql://unused@127.0.0.1:1/unused",
});
const origin = "https://coder.background.invalid";
const hour = 3600000;
const owners: string[] = [];
const env: BackgroundEnvironment = {
  HIVE_NATIVE_MODE: "preview",
  HIVE_DATABASE_NAME: "hive_foundation_preview",
  HIVE_DATABASE_ROLE: "hive_foundation_runtime",
  DATABASE_URL: "postgresql://hive_foundation_runtime:fixture@localhost/hive_foundation_preview",
  HIVE_PUBLIC_ORIGIN: "https://fixture.workers.dev",
  ASSETS: { fetch: vi.fn() },
  BACKGROUND: { getByName: vi.fn() },
};

beforeAll(() => vi.stubEnv("CODER_URL", origin));
afterAll(async () => {
  if (connection) {
    await db.coderToken.deleteMany({ where: { userId: { in: owners } } });
    await db.user.deleteMany({ where: { id: { in: owners } } });
  }
  await db.$disconnect();
  vi.unstubAllEnvs();
});

async function credential(
  options: {
    expiresAt?: Date | null;
    createdAt?: Date;
    rotationNextAt?: Date;
    rotationLeaseUntil?: Date;
    coderUrl?: string;
    pending?: boolean;
  } = {},
) {
  const ownerId = randomUUID();
  owners.push(ownerId);
  const coderUserId = randomUUID();
  await db.user.create({
    data: {
      id: ownerId,
      coderUserId,
      coderUrl: options.coderUrl ?? origin,
      username: "background-schedule-fixture",
      email: `${ownerId}@example.invalid`,
    },
  });
  const intentId = randomUUID();
  const token = await db.coderToken.create({
    data: {
      userId: ownerId,
      ciphertext: Uint8Array.of(1),
      iv: new Uint8Array(12),
      authTag: new Uint8Array(16),
      createdAt: options.createdAt ?? new Date(),
      expiresAt:
        options.expiresAt === undefined
          ? new Date(Date.now() + LEGACY_TOKEN_LIFETIME_MS)
          : options.expiresAt,
      rotationNextAt: options.rotationNextAt ?? new Date(0),
      rotationLeaseId: options.rotationLeaseUntil ? randomUUID() : null,
      rotationLeaseUntil: options.rotationLeaseUntil,
      rotationState: options.pending
        ? {
            schemaVersion: 1,
            managed: null,
            pending: {
              id: intentId,
              name: `hive-r-${intentId}`,
              scope: {
                ownerId,
                coderUserId,
                origin,
                version: 1,
                cipherDigest: "a".repeat(64),
              },
              phase: "minting",
              oldManaged: null,
              discardId: null,
              candidate: null,
            },
          }
        : undefined,
    },
  });
  return { ownerId, token };
}

describe.skipIf(!connection)("background scheduling / actual PostgreSQL", () => {
  it("schedules a fresh token at eligibility instead of its past retry time", async () => {
    const { ownerId, token } = await credential();
    const expected = token.expiresAt!.getTime() - LEGACY_TOKEN_ROTATION_WINDOW_MS;
    expect(await nextBackgroundAt(db, ownerId)).toBe(expected);
    expect(await nextBackgroundAt(db, ownerId)).toBe(expected);
    expect(expected).toBeGreaterThan(Date.now() + 20 * 24 * hour);
  });

  it("uses the lifetime fallback for a legacy token without explicit expiry", async () => {
    const { ownerId, token } = await credential({ expiresAt: null });
    expect(await nextBackgroundAt(db, ownerId)).toBe(
      token.createdAt.getTime() + LEGACY_TOKEN_LIFETIME_MS - LEGACY_TOKEN_ROTATION_WINDOW_MS,
    );
  });

  it("treats a persisted JSON-null pending value as idle", async () => {
    const { ownerId, token } = await credential();
    await db.coderToken.update({
      where: { id: token.id },
      data: { rotationState: { schemaVersion: 1, managed: null, pending: null } },
    });
    expect(await nextBackgroundAt(db, ownerId)).toBe(
      token.expiresAt!.getTime() - LEGACY_TOKEN_ROTATION_WINDOW_MS,
    );
  });

  it.each([false, true])("clears expired idle tokens with fallback expiry=%s", async (fallback) => {
    const { ownerId } = await credential({
      expiresAt: fallback ? null : new Date(Date.now() - hour),
      createdAt: new Date(Date.now() - LEGACY_TOKEN_LIFETIME_MS - hour),
    });
    expect(await nextBackgroundAt(db, ownerId)).toBeNull();
  });

  it("returns past-due work once the rotation threshold is reached", async () => {
    const { ownerId, token } = await credential({
      expiresAt: new Date(Date.now() + LEGACY_TOKEN_ROTATION_WINDOW_MS - hour),
    });
    const next = await nextBackgroundAt(db, ownerId);
    expect(next).toBe(token.expiresAt!.getTime() - LEGACY_TOKEN_ROTATION_WINDOW_MS);
    expect(next).toBeLessThan(Date.now());
  });

  it("preserves retry backoff and active leases for due tokens", async () => {
    const retry = new Date(Date.now() + hour);
    const lease = new Date(retry.getTime() + hour);
    const { ownerId } = await credential({
      expiresAt: new Date(Date.now() + hour),
      rotationNextAt: retry,
      rotationLeaseUntil: lease,
    });
    expect(await nextBackgroundAt(db, ownerId)).toBe(lease.getTime());
  });

  it("keeps expired pending reconciliation eligible while respecting its lease", async () => {
    const lease = new Date(Date.now() + hour);
    const { ownerId } = await credential({
      expiresAt: new Date(Date.now() - hour),
      pending: true,
      rotationLeaseUntil: lease,
    });
    expect(await nextBackgroundAt(db, ownerId)).toBe(lease.getTime());
  });

  it("allows pending reconciliation before a fresh token reaches its rotation window", async () => {
    const { ownerId } = await credential({ pending: true });
    expect(await nextBackgroundAt(db, ownerId)).toBe(0);
  });

  it("isolates owners and excludes credentials from another configured Coder origin", async () => {
    await credential({ expiresAt: new Date(Date.now() + hour) });
    expect(await nextBackgroundAt(db, randomUUID())).toBeNull();
    const foreign = await credential({
      expiresAt: new Date(Date.now() + hour),
      coderUrl: "https://other.invalid",
      pending: true,
    });
    expect(await nextBackgroundAt(db, foreign.ownerId)).toBeNull();
  });

  it("repairs only currently claimable rotation work", async () => {
    const fresh = await credential();
    const expired = await credential({ expiresAt: new Date(Date.now() - hour) });
    const due = await credential({ expiresAt: new Date(Date.now() + hour) });
    const pending = await credential({ expiresAt: new Date(Date.now() - hour), pending: true });
    const leased = await credential({
      expiresAt: new Date(Date.now() + hour),
      rotationLeaseUntil: new Date(Date.now() + hour),
    });
    const delayed = await credential({
      expiresAt: new Date(Date.now() + hour),
      rotationNextAt: new Date(Date.now() + hour),
    });
    const foreign = await credential({
      expiresAt: new Date(Date.now() + hour),
      coderUrl: "https://other.invalid",
    });
    mocks.wake.mockClear();
    await repairBackground(env);
    const repaired = new Set(mocks.wake.mock.calls.map(([, owner]) => owner));
    expect(repaired.has(due.ownerId)).toBe(true);
    expect(repaired.has(pending.ownerId)).toBe(true);
    for (const fixture of [fresh, expired, leased, delayed, foreign])
      expect(repaired.has(fixture.ownerId)).toBe(false);
  });
});
