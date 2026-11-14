import { randomUUID } from "node:crypto";
import { createTerminalTicket } from "@hive/auth";
import { createDatabaseRequest, PrismaClient } from "@hive/db";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanupTerminalDiagnostics,
  createTerminalDiagnostics,
  readTerminalDiagnostics,
  type TerminalDiagnosticScope,
  terminalDiagnosticsRuntime,
} from "@/lib/terminal/diagnostics.server";
import { parseTerminalSessionEventPayload } from "@/lib/terminal/session-events";

const url = process.env.HIVE_TERMINAL_DIAGNOSTICS_TEST_DATABASE_URL;
if (
  url &&
  (new URL(url).hostname !== "127.0.0.1" ||
    new URL(url).port !== "55439" ||
    new URL(url).pathname !== "/hive_terminal_diagnostics_test_20261113")
)
  throw new Error("Dedicated terminal diagnostic fixture required");
const db = new PrismaClient({
  datasourceUrl: url ?? "postgresql://unused@127.0.0.1:1/hive_terminal_diagnostics_test_20261113",
});
const scope = (): TerminalDiagnosticScope => ({
  userId: randomUUID(),
  coderUserId: randomUUID(),
  coderOrigin: "https://coder.example",
  workspaceId: randomUUID(),
  buildId: randomUUID(),
  agentId: randomUUID(),
  sessionName: "session-1",
  sessionKind: "terminal",
  expiresAt: Date.now() + 3600000,
});
let created = 0,
  disposed = 0;
const factory = () => {
  created++;
  const request = createDatabaseRequest(() => new PrismaClient({ datasourceUrl: url }));
  return {
    run: request.run,
    async close() {
      await request.close();
      disposed++;
    },
  };
};
const reader = (s: TerminalDiagnosticScope, workspaceIds = new Set([s.workspaceId])) => ({
  userId: s.userId,
  coderUserId: s.coderUserId,
  coderOrigin: s.coderOrigin,
  workspaceIds,
});
const read = (s: TerminalDiagnosticScope, path = "/session-events") =>
  readTerminalDiagnostics(db, reader(s), new URL(`https://hive.example${path}`));
beforeEach(async () => {
  if (url) await db.$executeRawUnsafe("TRUNCATE terminal_connections,terminal_events");
  created = disposed = 0;
});
afterAll(async () => {
  await db.$disconnect();
  vi.unstubAllEnvs();
});

describe.skipIf(!url)("PostgreSQL terminal diagnostics", () => {
  it("uses new request lifetimes after admission closes and survives another isolate reader", async () => {
    const s = scope();
    const admission = createDatabaseRequest(() => db, factory);
    const hooks = admission.run(() => createTerminalDiagnostics(s));
    await admission.close();
    expect(await hooks.open()).toBe(true);
    expect(await hooks.open()).toBe(false);
    hooks.activity("browser_input", 12);
    hooks.activity("upstream_output", 24);
    expect(await hooks.heartbeat()).toBe(true);
    const first = (await read(s)) as { instanceId: string; events: { type: string }[] };
    expect(first.events.map((event) => event.type)).toEqual([
      "connection_accepted",
      "heartbeat",
      "browser_input",
      "upstream_output",
    ]);
    expect(parseTerminalSessionEventPayload(first)).not.toBeNull();
    expect(((await read(s)) as { instanceId: string }).instanceId).toBe(first.instanceId);
    expect(created).toBe(disposed);
  });
  it("aggregates multiple connections and preserves actual keepalive failure/success fields", async () => {
    const s = scope(),
      a = createTerminalDiagnostics(s, factory),
      b = createTerminalDiagnostics({ ...s, sessionName: "session-2" }, factory);
    await Promise.all([a.open(), b.open()]);
    await a.keepalive({ ok: false, httpStatus: 503, durationMs: 150 });
    await b.heartbeat();
    const result = (await read(s, "/keepalive/status")) as { workspaces: Record<string, any> };
    expect(result.workspaces[s.workspaceId]).toMatchObject({
      status: "failing",
      activeConnectionCount: 2,
      consecutiveFailures: 1,
      lastHttpStatus: 503,
      lastFailureReason: "coder-server-error",
      lastAttemptDurationMs: 150,
    });
    await b.keepalive({ ok: true, httpStatus: 200, durationMs: 20 });
    expect(
      ((await read(s, "/keepalive/status")) as typeof result).workspaces[s.workspaceId],
    ).toMatchObject({ status: "healthy", consecutiveFailures: 0, activeConnectionCount: 2 });
    await a.close();
    await b.close();
    expect(
      ((await read(s, "/keepalive/status")) as typeof result).workspaces[s.workspaceId],
    ).toMatchObject({ status: "recently-disconnected", activeConnectionCount: 0 });
  });
  it("preserves manual-shutdown nonapplicability and excludes arbitrary event payloads", async () => {
    const s = scope(),
      hooks = createTerminalDiagnostics(s, factory);
    await hooks.open();
    await hooks.keepalive({
      ok: false,
      httpStatus: 409,
      category: "manual-shutdown",
      durationMs: 10,
    });
    const result = (await read(s, "/keepalive/status")) as { workspaces: Record<string, any> };
    expect(result.workspaces[s.workspaceId]).toMatchObject({
      status: "not-applicable",
      consecutiveFailures: 0,
      lastFailureReason: "manual-shutdown",
      lastHttpStatus: 409,
    });
    await expect(
      hooks.event("upstream_output", { token: "synthetic-secret" } as never),
    ).rejects.toThrow();
    expect(await db.terminalEvent.count()).toBe(1);
  });
  it("flushes short-session traffic on close without issuing a new heartbeat lease", async () => {
    const s = scope(),
      hooks = createTerminalDiagnostics(s, factory);
    await hooks.open();
    hooks.activity("browser_input", 4);
    hooks.activity("upstream_output", 16);
    await hooks.close();
    await hooks.close();
    const result = (await read(s)) as { events: { type: string; details: object }[] };
    expect(result.events.map((event) => event.type)).toEqual([
      "connection_accepted",
      "browser_input",
      "upstream_output",
      "browser_disconnected",
    ]);
    expect(result.events[1].details).toEqual({ bytes: 4, frames: 1 });
    expect(result.events[2].details).toEqual({ bytes: 16, frames: 1 });
  });
  it("never revives closed or expired leases and accepts a late close without extending authority", async () => {
    const s = scope(),
      hooks = createTerminalDiagnostics(s, factory);
    await hooks.open();
    const expiry = new Date(Date.now() - 1000);
    await db.terminalConnection.update({
      where: { id: hooks.connectionId },
      data: { authorityExpiresAt: expiry, leaseUntil: expiry },
    });
    expect(await hooks.heartbeat()).toBe(false);
    await hooks.close(4401, "upstream_closed");
    await hooks.close(4401, "upstream_closed");
    expect(await hooks.heartbeat()).toBe(false);
    expect(
      (await db.terminalConnection.findUniqueOrThrow({ where: { id: hooks.connectionId } }))
        .authorityExpiresAt,
    ).toEqual(expiry);
    expect(await db.terminalEvent.count({ where: { type: "upstream_closed" } })).toBe(1);
  });
  it("clamps shorter authority across later longer refreshes", async () => {
    const s = scope(),
      hooks = createTerminalDiagnostics(s, factory);
    await hooks.open();
    const short = Date.now() + 30000;
    await hooks.heartbeat(short);
    await hooks.heartbeat(s.expiresAt);
    expect(
      (
        await db.terminalConnection.findUniqueOrThrow({ where: { id: hooks.connectionId } })
      ).authorityExpiresAt.getTime(),
    ).toBe(short);
  });
  it("fences other Hive users, Coder identities, origins and unauthorized workspace filters", async () => {
    const s = scope(),
      hooks = createTerminalDiagnostics(s, factory);
    await hooks.open();
    for (const other of [
      { ...s, userId: randomUUID() },
      { ...s, coderUserId: randomUUID() },
      { ...s, coderOrigin: "https://other.example" },
    ]) {
      expect(((await read(other)) as { events: unknown[] }).events).toEqual([]);
      expect(
        ((await read(other, "/keepalive/status")) as { workspaces: object }).workspaces,
      ).toEqual({});
    }
    expect(
      await readTerminalDiagnostics(
        db,
        reader(s, new Set()),
        new URL(`https://hive.example/session-events?workspaceId=${s.workspaceId}`),
      ),
    ).toBeNull();
  });
  it("preserves cursor, session and bounded newest/oldest query contracts", async () => {
    const s = scope(),
      a = createTerminalDiagnostics(s, factory),
      b = createTerminalDiagnostics({ ...s, sessionName: "second" }, factory);
    await a.open();
    await b.open();
    await a.event("upstream_connected");
    const first = (await read(s, "/session-events?limit=2")) as {
      events: { id: number; sessionName: string }[];
    };
    expect(first.events).toHaveLength(2);
    const cursor = first.events[0].id;
    const next = (await read(s, `/session-events?after=${cursor}&limit=1`)) as typeof first;
    expect(next.events.map((event) => event.id)).toEqual([first.events[1].id]);
    const filtered = (await read(s, "/session-events?sessionName=second")) as typeof first;
    expect(filtered.events).toHaveLength(1);
    expect(filtered.events[0].sessionName).toBe("second");
  });
  it("caps retained events and removes expired metadata with bounded visible retention", async () => {
    const s = scope(),
      hooks = createTerminalDiagnostics(s, factory);
    await hooks.open();
    const data = {
      userId: s.userId,
      coderUserId: s.coderUserId,
      coderOrigin: s.coderOrigin,
      workspaceId: s.workspaceId,
      connectionId: hooks.connectionId,
      sessionName: s.sessionName,
      sessionKind: s.sessionKind,
      level: "info",
      type: "heartbeat",
      details: {},
    };
    await db.terminalEvent.createMany({ data: Array.from({ length: 4005 }, () => data) });
    await hooks.heartbeat();
    expect(await db.terminalEvent.count()).toBe(4000);
    await db.terminalEvent.updateMany({ data: { createdAt: new Date(Date.now() - 86401000) } });
    expect(((await read(s)) as { events: unknown[] }).events).toEqual([]);
  });
  it("sweeps abandoned users with a finite cleanup batch while preserving live rows", async () => {
    const s = scope(),
      hooks = createTerminalDiagnostics(s, factory);
    await hooks.open();
    await db.terminalEvent.updateMany({ data: { createdAt: new Date(Date.now() - 86401000) } });
    const other = scope(),
      dead = createTerminalDiagnostics(other, factory);
    await dead.open();
    await db.terminalConnection.update({
      where: { id: dead.connectionId },
      data: { leaseUntil: new Date(Date.now() - 301000) },
    });
    expect(await cleanupTerminalDiagnostics(db)).toEqual({ events: 1, connections: 1 });
    expect(
      await db.terminalConnection.findUnique({ where: { id: hooks.connectionId } }),
    ).not.toBeNull();
  });
  it("serializes event commits and readers so a cursor cannot skip an earlier uncommitted event", async () => {
    const s = scope(),
      hooks = createTerminalDiagnostics(s, factory);
    await hooks.open();
    let entered!: () => void, release!: () => void;
    const ready = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${s.userId}, 73191))`;
      await tx.terminalEvent.create({
        data: {
          userId: s.userId,
          coderUserId: s.coderUserId,
          coderOrigin: s.coderOrigin,
          workspaceId: s.workspaceId,
          connectionId: hooks.connectionId,
          sessionName: s.sessionName,
          sessionKind: s.sessionKind,
          level: "info",
          type: "upstream_connecting",
          details: {},
        },
      });
      entered();
      await gate;
    });
    await ready;
    const second = hooks.event("upstream_connected");
    const reading = read(s);
    release();
    await Promise.all([first, second, reading]);
    const result = (await read(s)) as { events: { type: string; id: number }[] };
    expect(result.events.map((event) => event.type)).toEqual([
      "connection_accepted",
      "upstream_connecting",
      "upstream_connected",
    ]);
    expect(result.events.map((event) => event.id)).toEqual(
      [...result.events.map((event) => event.id)].sort((a, b) => a - b),
    );
  });
  it("authenticates cookie-free HTTP tickets with fresh session, token and Coder owner inventory", async () => {
    const s = scope(),
      hooks = createTerminalDiagnostics(s, factory);
    await hooks.open();
    const origin = "https://hive.example",
      secret = "synthetic-secret";
    const target = `/session-events?workspaceId=${s.workspaceId}`;
    const ticket = createTerminalTicket(
      { sessionId: "session", audience: "hive.example", origin, requestTarget: target },
      secret,
      Date.now() + 60000,
    );
    const auth = vi.fn<typeof fetch>(async (input) =>
      String(input).endsWith("/token")
        ? Response.json({ token: "synthetic-token", coderUrl: s.coderOrigin, expiresAt: null })
        : Response.json({
            sessionId: "session",
            userId: s.userId,
            coderUserId: s.coderUserId,
            coderUrl: s.coderOrigin,
            expiresAt: new Date(s.expiresAt).toISOString(),
          }),
    );
    const provider = vi.fn<typeof fetch>(async (input, init) => {
      expect(new Headers(init?.headers).get("Coder-Session-Token")).toBe("synthetic-token");
      expect(init?.redirect).toBe("manual");
      return String(input).includes("/users/me")
        ? Response.json({ id: s.coderUserId })
        : Response.json({ workspaces: [{ id: s.workspaceId, owner_id: s.coderUserId }] });
    });
    const request = new Request(`${origin}${target}`, {
      headers: { Authorization: `Bearer ${ticket}` },
    });
    const env = {
      HIVE_PUBLIC_ORIGIN: origin,
      HIVE_GENERIC_TERMINAL_ENABLED: "true",
      COOKIE_SECRET: secret,
      CODER_URL: s.coderOrigin,
      AUTH_SERVICE_SECRET: "a".repeat(64),
      AUTH_SERVICE: { fetch: auth },
    };
    const context = factory();
    try {
      const response = await context.run(() => terminalDiagnosticsRuntime(request, env, provider));
      expect(response.status).toBe(200);
      expect((await response.json()).events).toHaveLength(1);
      expect(auth).toHaveBeenCalledTimes(2);
      expect(provider).toHaveBeenCalledTimes(2);
      provider.mockImplementation(async (input) =>
        String(input).includes("/users/me")
          ? Response.json({ id: randomUUID() })
          : Response.json({ workspaces: [{ id: s.workspaceId, owner_id: s.coderUserId }] }),
      );
      expect(
        (await context.run(() => terminalDiagnosticsRuntime(request, env, provider))).status,
      ).toBe(403);
    } finally {
      await context.close();
    }
  });
});
