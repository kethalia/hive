import { createHash, randomUUID } from "node:crypto";
import { verifyTerminalTicket } from "@hive/auth";
import { captureRequestDatabaseFactory, getDb, type Prisma, type PrismaClient } from "@hive/db";
import { z } from "zod";
import type { GenericTerminalEnvironment } from "../../../deploy/cloudflare/app/generic-terminal-runtime";
import type { SerializedWorkspaceHealth } from "../../../services/terminal-proxy/src/keepalive";
import type { RecordTerminalSessionEventInput } from "../../../services/terminal-proxy/src/session-events";
import { genericTerminalAuthClient, genericTerminalSessionSchema } from "./generic-auth.server";
import type { TerminalSessionEventPayload } from "./session-events";
import { cancelTerminalBody, terminalBody, terminalFetch } from "./transport-io";

type DatabaseFactory = NonNullable<ReturnType<typeof captureRequestDatabaseFactory>>;
type Transaction = Prisma.TransactionClient;
const LEASE_MS = 60000;
const RECENT_MS = 300000;
const EVENT_TTL_MS = 86400000;
const MAX_EVENTS = 4000;
const uuid = z.string().uuid();
const scopeSchema = z
  .object({
    userId: uuid,
    coderUserId: uuid,
    coderOrigin: z.string().url(),
    workspaceId: uuid,
    buildId: uuid,
    agentId: uuid,
    sessionName: z.string().regex(/^[A-Za-z0-9._-]{1,200}$/),
    sessionKind: z.enum(["git", "terminal"]),
    expiresAt: z.number().finite().positive().max(8640000000000000),
  })
  .strict();
export type TerminalDiagnosticScope = z.infer<typeof scopeSchema>;
const detailNumber = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional();
const detailsSchema = z
  .object({
    bytes: detailNumber,
    frames: detailNumber,
    rows: detailNumber,
    cols: detailNumber,
    code: detailNumber,
    bufferedBytes: detailNumber,
    browserMissed: detailNumber,
    upstreamMissed: detailNumber,
    frame: z.enum(["resize", "input", "text"]).optional(),
    leg: z.enum(["browser", "upstream", "both"]).optional(),
  })
  .strict();
const eventSchema = z.enum([
  "browser_backpressure",
  "browser_disconnected",
  "browser_error",
  "browser_input",
  "connection_accepted",
  "heartbeat",
  "heartbeat_timeout",
  "upstream_closed",
  "upstream_connect_timeout",
  "upstream_connected",
  "upstream_connecting",
  "upstream_error",
  "upstream_output",
]);
export type TerminalDiagnosticEvent = z.infer<typeof eventSchema>;
export type TerminalKeepaliveOutcome = {
  ok: boolean;
  httpStatus?: number;
  category?: "timeout" | "network" | "manual-shutdown";
  durationMs: number;
};
const emptyHealth = (): SerializedWorkspaceHealth => ({
  status: "healthy",
  consecutiveFailures: 0,
  lastSuccess: null,
  lastFailure: null,
  lastAttempt: null,
  lastFailureCategory: null,
  lastFailureReason: null,
  lastFailureDetail: null,
  lastHttpStatus: null,
  lastHttpStatusText: null,
  lastAttemptDurationMs: null,
  activeConnectionCount: 0,
  lastDisconnectedAt: null,
});
const healthSchema = z.object({
  status: z.enum(["healthy", "failing", "not-applicable", "no-token", "recently-disconnected"]),
  consecutiveFailures: z.number().int().nonnegative(),
  lastSuccess: z.string().nullable(),
  lastFailure: z.string().nullable(),
  lastAttempt: z.string().nullable(),
  lastFailureCategory: z
    .enum([
      "manual-shutdown",
      "http-auth",
      "http-client",
      "http-server",
      "timeout",
      "network",
      "unknown",
    ])
    .nullable(),
  lastFailureReason: z
    .enum([
      "manual-shutdown",
      "coder-auth-rejected",
      "workspace-not-found",
      "coder-client-error",
      "coder-server-error",
      "coder-timeout",
      "network-error",
      "unknown-error",
    ])
    .nullable(),
  lastFailureDetail: z.string().max(200).nullable(),
  lastHttpStatus: z.number().int().nullable(),
  lastHttpStatusText: z.string().max(100).nullable(),
  lastAttemptDurationMs: z.number().nullable(),
  activeConnectionCount: z.number().int().nonnegative(),
  lastDisconnectedAt: z.string().nullable(),
});
function owner(scope: Pick<TerminalDiagnosticScope, "userId" | "coderUserId" | "coderOrigin">) {
  return { userId: scope.userId, coderUserId: scope.coderUserId, coderOrigin: scope.coderOrigin };
}
async function lock(tx: Transaction, userId: string) {
  // Event sequence allocation is serialized through commit for each user's cursor.
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${userId}, 73191))`;
}
async function cleanup(tx: Transaction, userId: string, now: Date) {
  await tx.$executeRaw`DELETE FROM terminal_events WHERE user_id=${userId}::uuid AND
    (created_at < ${new Date(now.getTime() - EVENT_TTL_MS)} OR id IN
      (SELECT id FROM terminal_events WHERE user_id=${userId}::uuid ORDER BY id DESC OFFSET ${MAX_EVENTS}))`;
  await tx.terminalConnection.deleteMany({
    where: {
      userId,
      OR: [
        { closedAt: { lt: new Date(now.getTime() - RECENT_MS) } },
        { closedAt: null, leaseUntil: { lt: new Date(now.getTime() - RECENT_MS) } },
      ],
    },
  });
}
async function requestDatabase<T>(
  factory: DatabaseFactory,
  operation: (db: PrismaClient) => Promise<T>,
) {
  const request = factory({ queryTimeoutMillis: 5000, transactionTimeoutMillis: 5000 });
  try {
    return await request.run(() => operation(getDb()));
  } finally {
    await request.close();
  }
}

/** Capture the sibling factory while the admission request is live. Each later
 * callback creates and disposes its own request-scoped database lifetime. */
export function createTerminalDiagnostics(
  raw: TerminalDiagnosticScope,
  factory = captureRequestDatabaseFactory(),
) {
  const scope = scopeSchema.parse(raw);
  if (!factory) throw new Error("Terminal diagnostics database scope unavailable");
  const databaseFactory = factory;
  const connectionId = randomUUID();
  const where = {
    id: connectionId,
    ...owner(scope),
    workspaceId: scope.workspaceId,
    buildId: scope.buildId,
    agentId: scope.agentId,
  };
  const traffic = {
    browser_input: { bytes: 0, frames: 0 },
    upstream_output: { bytes: 0, frames: 0 },
  };
  let closed = false;
  async function insertEvent(
    tx: Transaction,
    type: TerminalDiagnosticEvent,
    details: z.infer<typeof detailsSchema> = {},
    level: RecordTerminalSessionEventInput["level"] = "info",
  ) {
    await tx.terminalEvent.create({
      data: {
        ...owner(scope),
        workspaceId: scope.workspaceId,
        connectionId,
        sessionName: scope.sessionName,
        sessionKind: scope.sessionKind,
        type,
        level,
        details,
      },
    });
  }
  async function transaction<T>(operation: (tx: Transaction, now: Date) => Promise<T>) {
    return requestDatabase(databaseFactory, (db) =>
      db.$transaction(async (tx) => {
        await lock(tx, scope.userId);
        const now = new Date();
        const result = await operation(tx, now);
        await cleanup(tx, scope.userId, now);
        return result;
      }),
    );
  }
  const live = (now: Date) => ({
    ...where,
    closedAt: null,
    leaseUntil: { gt: now },
    authorityExpiresAt: { gt: now },
  });
  return {
    connectionId,
    async open() {
      if (closed) return false;
      return transaction(async (tx, now) => {
        if (scope.expiresAt <= now.getTime()) return false;
        const inserted = await tx.terminalConnection.createMany({
          data: {
            ...where,
            sessionName: scope.sessionName,
            sessionKind: scope.sessionKind,
            authorityExpiresAt: new Date(scope.expiresAt),
            leaseUntil: new Date(Math.min(scope.expiresAt, now.getTime() + LEASE_MS)),
            health: { ...emptyHealth() },
          },
          skipDuplicates: true,
        });
        if (inserted.count) await insertEvent(tx, "connection_accepted");
        return inserted.count === 1;
      });
    },
    activity(type: "browser_input" | "upstream_output", bytes: number) {
      if (closed || !Number.isSafeInteger(bytes) || bytes < 0) return;
      const value = traffic[type];
      value.bytes = Math.min(Number.MAX_SAFE_INTEGER, value.bytes + bytes);
      value.frames = Math.min(Number.MAX_SAFE_INTEGER, value.frames + 1);
    },
    async heartbeat(expiresAt = scope.expiresAt) {
      if (closed) return false;
      const expiry = Math.min(scope.expiresAt, expiresAt);
      if (!Number.isFinite(expiry)) throw new Error("Terminal diagnostic expiry rejected");
      const batch = {
        browser_input: { ...traffic.browser_input },
        upstream_output: { ...traffic.upstream_output },
      };
      return transaction(async (tx, now) => {
        const current = await tx.terminalConnection.findFirst({
          where: live(now),
          select: { authorityExpiresAt: true },
        });
        if (!current) return false;
        const clippedExpiry = Math.min(expiry, current.authorityExpiresAt.getTime());
        if (clippedExpiry <= now.getTime()) return false;
        const changed = await tx.terminalConnection.updateMany({
          where: live(now),
          data: {
            updatedAt: now,
            leaseUntil: new Date(Math.min(clippedExpiry, now.getTime() + LEASE_MS)),
            authorityExpiresAt: new Date(clippedExpiry),
          },
        });
        if (!changed.count) return false;
        await insertEvent(tx, "heartbeat");
        for (const type of ["browser_input", "upstream_output"] as const)
          if (batch[type].frames) {
            await insertEvent(tx, type, batch[type]);
            traffic[type].bytes -= batch[type].bytes;
            traffic[type].frames -= batch[type].frames;
          }
        return true;
      });
    },
    async event(
      type: TerminalDiagnosticEvent,
      details: z.infer<typeof detailsSchema> = {},
      level: "info" | "warning" | "error" = "info",
    ) {
      eventSchema.parse(type);
      const safeDetails = detailsSchema.parse(details);
      if (closed) return;
      return transaction(async (tx, now) => {
        if (await tx.terminalConnection.findFirst({ where: live(now), select: { id: true } }))
          await insertEvent(tx, type, safeDetails, level);
      });
    },
    async keepalive(outcome: TerminalKeepaliveOutcome) {
      if (closed) return;
      if (
        !Number.isFinite(outcome.durationMs) ||
        outcome.durationMs < 0 ||
        (outcome.httpStatus !== undefined &&
          (!Number.isInteger(outcome.httpStatus) ||
            outcome.httpStatus < 100 ||
            outcome.httpStatus > 599))
      )
        throw new Error("Terminal keepalive outcome rejected");
      return transaction(async (tx, now) => {
        if (!(await tx.terminalConnection.findFirst({ where: live(now), select: { id: true } })))
          return;
        const previous = await tx.terminalConnection.findMany({
          where: { ...owner(scope), workspaceId: scope.workspaceId },
          select: { health: true },
        });
        const health =
          previous
            .map((row) => healthSchema.parse(row.health))
            .sort((a, b) => (b.lastAttempt ?? "").localeCompare(a.lastAttempt ?? ""))[0] ??
          emptyHealth();
        const stamp = now.toISOString();
        health.lastAttempt = stamp;
        health.lastAttemptDurationMs = Math.min(10000, Math.round(outcome.durationMs));
        if (outcome.ok) {
          health.status = "healthy";
          health.consecutiveFailures = 0;
          health.lastSuccess = stamp;
          health.lastFailureCategory = null;
          health.lastFailureReason = null;
          health.lastFailureDetail = null;
          health.lastHttpStatus = null;
          health.lastHttpStatusText = null;
        } else {
          health.status = "failing";
          health.consecutiveFailures++;
          health.lastFailure = stamp;
          const status = outcome.httpStatus;
          health.lastFailureCategory =
            outcome.category ??
            (status === 401 || status === 403
              ? "http-auth"
              : status && status < 500
                ? "http-client"
                : status
                  ? "http-server"
                  : "unknown");
          health.lastFailureReason =
            outcome.category === "manual-shutdown"
              ? "manual-shutdown"
              : outcome.category === "timeout"
                ? "coder-timeout"
                : outcome.category === "network"
                  ? "network-error"
                  : status === 401 || status === 403
                    ? "coder-auth-rejected"
                    : status === 404
                      ? "workspace-not-found"
                      : status && status < 500
                        ? "coder-client-error"
                        : status
                          ? "coder-server-error"
                          : "unknown-error";
          health.lastFailureDetail = "Workspace keepalive request failed.";
          if (outcome.category === "manual-shutdown") {
            health.status = "not-applicable";
            health.consecutiveFailures = 0;
            health.lastFailureDetail =
              "Coder reports workspace shutdown is manual; keepalive extension is not applicable.";
          }
          health.lastHttpStatus = status ?? null;
          health.lastHttpStatusText = null;
        }
        await tx.terminalConnection.updateMany({
          where: live(now),
          data: { health: { ...health }, updatedAt: now },
        });
      });
    },
    async close(code = 1000, reason: TerminalDiagnosticEvent = "browser_disconnected") {
      eventSchema.parse(reason);
      if (!Number.isInteger(code) || code < 1000 || code > 4999)
        throw new Error("Terminal close code rejected");
      closed = true;
      return transaction(async (tx, now) => {
        const current = await tx.terminalConnection.findFirst({
          where: { ...where, closedAt: null },
          select: { authorityExpiresAt: true },
        });
        if (!current) return;
        const changed = await tx.terminalConnection.updateMany({
          where: { ...where, closedAt: null },
          data: {
            closedAt: now,
            updatedAt: now,
            leaseUntil: new Date(Math.min(now.getTime(), current.authorityExpiresAt.getTime())),
            closeCode: code,
            closeReason: reason,
          },
        });
        if (changed.count) {
          for (const type of ["browser_input", "upstream_output"] as const) {
            if (traffic[type].frames) await insertEvent(tx, type, { ...traffic[type] });
          }
          await insertEvent(tx, reason, { code });
        }
      });
    },
  };
}

export type TerminalDiagnosticsReader = Pick<
  TerminalDiagnosticScope,
  "userId" | "coderUserId" | "coderOrigin"
> & { workspaceIds: ReadonlySet<string> };
export async function readTerminalDiagnostics(
  db: PrismaClient,
  principal: TerminalDiagnosticsReader,
  url: URL,
) {
  const now = new Date();
  const requested = url.searchParams.get("workspaceId")?.trim() || null;
  if (requested && !principal.workspaceIds.has(requested)) return null;
  const workspaceIds = requested ? [requested] : [...principal.workspaceIds];
  const where = { ...owner(principal), workspaceId: { in: workspaceIds } };
  return db.$transaction(async (tx) => {
    await lock(tx, principal.userId);
    await cleanup(tx, principal.userId, now);
    if (url.pathname === "/keepalive/status") {
      const rows = await tx.terminalConnection.findMany({
        where: {
          ...where,
          OR: [
            { closedAt: { gt: new Date(now.getTime() - RECENT_MS) } },
            { closedAt: null, leaseUntil: { gt: new Date(now.getTime() - RECENT_MS) } },
          ],
        },
        orderBy: { updatedAt: "desc" },
      });
      const workspaces: Record<string, SerializedWorkspaceHealth> = {};
      for (const row of rows) {
        const active =
          row.closedAt === null && row.leaseUntil > now && row.authorityExpiresAt > now;
        const candidate = healthSchema.parse(row.health);
        const existing = workspaces[row.workspaceId];
        const health = !existing
          ? { ...candidate, activeConnectionCount: 0, lastDisconnectedAt: null }
          : (candidate.lastAttempt ?? "") > (existing.lastAttempt ?? "")
            ? {
                ...candidate,
                activeConnectionCount: existing.activeConnectionCount,
                lastDisconnectedAt: existing.lastDisconnectedAt,
              }
            : existing;
        if (active) health.activeConnectionCount++;
        else if (!health.lastDisconnectedAt)
          health.lastDisconnectedAt = (row.closedAt ?? row.leaseUntil).toISOString();
        workspaces[row.workspaceId] = health;
      }
      for (const health of Object.values(workspaces)) {
        if (!health.activeConnectionCount) health.status = "recently-disconnected";
        else health.lastDisconnectedAt = null;
      }
      return { workspaces };
    }
    const integer = (value: string | null) => {
      const number = Number(value);
      return value && Number.isSafeInteger(number) && number >= 0 ? number : undefined;
    };
    const after = integer(url.searchParams.get("after")) ?? 0;
    const limit = Math.min(1000, Math.max(1, integer(url.searchParams.get("limit")) || 500));
    const rows = await tx.terminalEvent.findMany({
      where: {
        ...where,
        ...(url.searchParams.get("sessionName")?.trim()
          ? { sessionName: url.searchParams.get("sessionName")?.trim() }
          : {}),
        id: { gt: BigInt(after) },
      },
      orderBy: { id: after > 0 ? "asc" : "desc" },
      take: limit,
    });
    if (!after) rows.reverse();
    if (rows.some((row) => row.id > BigInt(Number.MAX_SAFE_INTEGER)))
      throw new Error("Terminal event cursor exhausted");
    const payload: TerminalSessionEventPayload = {
      version: 1,
      instanceId: `terminal-db-v1-${createHash("sha256").update(`${principal.userId}\0${principal.coderOrigin}\0${principal.coderUserId}`).digest("hex").slice(0, 32)}`,
      startedAt: rows[0]?.createdAt.toISOString() ?? now.toISOString(),
      generatedAt: now.toISOString(),
      events: rows.map((row) => ({
        id: Number(row.id),
        timestamp: row.createdAt.toISOString(),
        workspaceId: row.workspaceId,
        connectionId: row.connectionId,
        sessionName: row.sessionName,
        sessionKind: row.sessionKind as "git" | "terminal",
        level: row.level as "info" | "warning" | "error",
        type: row.type,
        details: detailsSchema.parse(row.details),
      })),
    };
    return payload;
  });
}

export function parseTerminalDiagnosticsTarget(url: URL) {
  if (
    !["/keepalive/status", "/session-events"].includes(url.pathname) ||
    url.hash ||
    url.search.length > 2048
  )
    return null;
  const fields =
    url.pathname === "/session-events" ? ["workspaceId", "sessionName", "after", "limit"] : [];
  if (
    [...url.searchParams.keys()].some(
      (key) => !fields.includes(key) || url.searchParams.getAll(key).length !== 1,
    )
  )
    return null;
  const workspaceId = url.searchParams.get("workspaceId")?.trim();
  const sessionName = url.searchParams.get("sessionName")?.trim();
  if (
    (workspaceId && !uuid.safeParse(workspaceId).success) ||
    (sessionName && !/^[A-Za-z0-9._-]{1,200}$/.test(sessionName))
  )
    return null;
  return { path: url.pathname, workspaceId: workspaceId || null, sessionName: sessionName || null };
}
export function terminalDiagnosticsPath(request: Request) {
  return ["/keepalive/status", "/session-events"].includes(new URL(request.url).pathname);
}
export async function terminalDiagnosticsRuntime(
  request: Request,
  env: GenericTerminalEnvironment,
  fetcher: typeof fetch = fetch,
) {
  const fail = (status: number) =>
    Response.json(
      { error: "Workspace terminal diagnostics unavailable" },
      { status, headers: { "Cache-Control": "private, no-store" } },
    );
  if (!terminalDiagnosticsPath(request) || env.HIVE_GENERIC_TERMINAL_ENABLED !== "true")
    return fail(404);
  if (!parseTerminalDiagnosticsTarget(new URL(request.url))) return fail(400);
  if (request.method !== "GET") return fail(405);
  const url = new URL(request.url);
  if (
    url.origin !== env.HIVE_PUBLIC_ORIGIN ||
    request.headers.get("Sec-Fetch-Site") === "cross-site" ||
    (request.headers.has("Origin") && request.headers.get("Origin") !== env.HIVE_PUBLIC_ORIGIN)
  )
    return fail(403);
  const bearer = request.headers.get("Authorization");
  const ticket =
    env.COOKIE_SECRET && bearer?.startsWith("Bearer ")
      ? verifyTerminalTicket(bearer.slice(7), env.COOKIE_SECRET, {
          audience: url.host,
          origin: url.origin,
          requestTarget: url.pathname + url.search,
        })
      : null;
  if (!ticket) return fail(401);
  const signal = AbortSignal.any([request.signal, AbortSignal.timeout(20000)]);
  try {
    const auth = genericTerminalAuthClient(env, signal);
    const replies = await Promise.allSettled([
      auth.getSession(ticket.sessionId),
      auth.getCoderToken(ticket.sessionId),
    ]);
    if (replies[0].status !== "fulfilled" || replies[1].status !== "fulfilled") return fail(401);
    const session = genericTerminalSessionSchema.parse(replies[0].value);
    const credential = z
      .object({
        token: z
          .string()
          .min(1)
          .max(4096)
          .regex(/^[!-~]+$/),
        coderUrl: z.string(),
        expiresAt: z.string().nullable(),
      })
      .strict()
      .parse(replies[1].value);
    if (
      session.sessionId !== ticket.sessionId ||
      session.coderUrl !== env.CODER_URL ||
      credential.coderUrl !== env.CODER_URL ||
      Date.parse(session.expiresAt) <= Date.now() ||
      !Number.isFinite(Date.parse(session.expiresAt)) ||
      (credential.expiresAt !== null &&
        (!Number.isFinite(Date.parse(credential.expiresAt)) ||
          Date.parse(credential.expiresAt) <= Date.now()))
    )
      return fail(401);
    const expiry = Math.min(
      Date.parse(session.expiresAt),
      credential.expiresAt === null ? Infinity : Date.parse(credential.expiresAt),
    );
    const authoritySignal = AbortSignal.any([
      signal,
      AbortSignal.timeout(Math.min(2147483647, Math.max(1, expiry - Date.now()))),
    ]);
    const provider = async (path: string) => {
      const response = await terminalFetch(
        fetcher(`${env.CODER_URL}${path}`, {
          redirect: "manual",
          credentials: "omit",
          signal: authoritySignal,
          headers: { "Coder-Session-Token": credential.token, Accept: "application/json" },
        }),
        authoritySignal,
      );
      if (response.status !== 200 || response.redirected) {
        await cancelTerminalBody(response);
        throw new Error("owner unavailable");
      }
      return JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(
          await terminalBody(response, 1048576, authoritySignal),
        ),
      );
    };
    const [user, list] = await Promise.allSettled([
      provider("/api/v2/users/me"),
      provider(`/api/v2/workspaces?q=${encodeURIComponent("owner:me")}`),
    ]);
    if (user.status !== "fulfilled" || list.status !== "fulfilled") return fail(502);
    if (user.value?.id !== session.coderUserId) return fail(403);
    const workspaces = z
      .object({ workspaces: z.array(z.object({ id: uuid, owner_id: uuid })).max(1000) })
      .parse(list.value);
    const workspaceIds = new Set(
      workspaces.workspaces
        .filter((workspace) => workspace.owner_id === session.coderUserId)
        .map((workspace) => workspace.id),
    );
    authoritySignal.throwIfAborted();
    const result = await readTerminalDiagnostics(
      getDb(),
      {
        userId: session.userId,
        coderUserId: session.coderUserId,
        coderOrigin: session.coderUrl,
        workspaceIds,
      },
      url,
    );
    authoritySignal.throwIfAborted();
    return result
      ? Response.json(result, { headers: { "Cache-Control": "private, no-store" } })
      : fail(404);
  } catch {
    return fail(502);
  }
}

/** Bounded retention sweep for the existing Worker scheduled entry point.
 * Owner reads also prune their own retained stream before returning metadata. */
export async function cleanupTerminalDiagnostics(db: PrismaClient = getDb()) {
  const events = await db.$executeRaw`DELETE FROM terminal_events WHERE id IN
    (SELECT id FROM terminal_events WHERE created_at < CURRENT_TIMESTAMP - INTERVAL '24 hours'
     ORDER BY created_at LIMIT 1000)`;
  const connections = await db.$executeRaw`DELETE FROM terminal_connections WHERE id IN
    (SELECT id FROM terminal_connections WHERE COALESCE(closed_at,lease_until) < CURRENT_TIMESTAMP - INTERVAL '5 minutes'
     ORDER BY COALESCE(closed_at,lease_until) LIMIT 1000)`;
  return { events, connections };
}
