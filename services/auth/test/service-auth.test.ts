import { createServer, type Server } from "node:http";
import { AuthServiceClient } from "@hive/auth";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { addRoute, clearRoutes, type RouteHandler } from "../src/router.js";
import { createRequestHandler, sendJson, startServer } from "../src/server.js";

const SECRET = "a".repeat(64);
const endpoints = [
  ["POST", "/login"],
  ["POST", "/logout"],
  ["GET", "/sessions/victim-session"],
  ["GET", "/sessions/victim-session/credentials"],
  ["GET", "/sessions/victim-session/token"],
] as const;

describe("auth service caller authentication", () => {
  let server: Server;
  let baseUrl: string;
  const protectedHandler = vi.fn<RouteHandler>(async (_req, res) =>
    sendJson(res, 200, { ok: true }),
  );

  beforeAll(async () => {
    clearRoutes();
    for (const [method, path] of endpoints) addRoute(method, path, protectedHandler);
    addRoute("GET", "/health", async (_req, res) => sendJson(res, 200, { status: "ok" }));
    server = createServer(createRequestHandler(SECRET));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing test server address");
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  beforeEach(() => {
    protectedHandler.mockClear();
    vi.stubEnv("AUTH_SERVICE_SECRET", SECRET);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  });

  it.each(
    endpoints,
  )("rejects unauthenticated %s %s before invoking its handler", async (method, path) => {
    const response = await fetch(`${baseUrl}${path}`, { method });
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      error: "Service authentication required",
      code: "SERVICE_UNAUTHORIZED",
    });
    expect(protectedHandler).not.toHaveBeenCalled();
  });

  it.each([
    `Bearer ${"b".repeat(64)}`,
    "Bearer short",
    `Basic ${SECRET}`,
    `Bearer ${SECRET}, Bearer ${SECRET}`,
    "",
  ])("rejects invalid credentials without invoking the token handler", async (authorization) => {
    const response = await fetch(`${baseUrl}/sessions/victim-session/token`, {
      headers: { Authorization: authorization },
    });
    expect(response.status).toBe(401);
    expect(protectedHandler).not.toHaveBeenCalled();
    expect(await response.text()).not.toContain(SECRET);
  });

  it.each(endpoints)("permits authenticated %s %s", async (method, path) => {
    const response = await fetch(`${baseUrl}${path}`, {
      method,
      headers: { Authorization: `Bearer ${SECRET}` },
    });
    expect(response.status).toBe(200);
    expect(protectedHandler).toHaveBeenCalledOnce();
  });

  it("keeps GET /health public while other methods and paths require authentication", async () => {
    expect((await fetch(`${baseUrl}/health`)).status).toBe(200);
    expect((await fetch(`${baseUrl}/health`, { method: "POST" })).status).toBe(401);
    expect((await fetch(`${baseUrl}/health/`)).status).toBe(401);
    expect((await fetch(`${baseUrl}/health/sessions/victim-session/token`)).status).toBe(401);
    expect(protectedHandler).not.toHaveBeenCalled();
  });

  it("rejects unauthorized requests before parsing their invalid JSON bodies", async () => {
    const response = await fetch(`${baseUrl}/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not json",
    });
    expect(response.status).toBe(401);
    expect(protectedHandler).not.toHaveBeenCalled();
  });

  it("accepts all shared client operations through the production authentication guard", async () => {
    const client = new AuthServiceClient(baseUrl);
    await client.login({
      coderUrl: "https://coder.test",
      email: "user@test",
      password: "password",
    });
    await client.logout("victim-session");
    await client.getSession("victim-session");
    await client.getCredentials("victim-session");
    await client.getCoderToken("victim-session");
    expect(protectedHandler).toHaveBeenCalledTimes(5);
  });

  it("does not log raw session IDs or credentials", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await fetch(`${baseUrl}/sessions/victim-session/token`, {
      headers: { Authorization: `Bearer ${SECRET}` },
    });
    expect(JSON.stringify(logSpy.mock.calls)).not.toContain("victim-session");
    expect(JSON.stringify(logSpy.mock.calls)).not.toContain(SECRET);
  });

  it("does not follow authenticated service redirects", async () => {
    addRoute("GET", "/sessions/redirect/token", async (_req, res) => {
      res.writeHead(307, { Location: "/sessions/victim-session/token" });
      res.end();
    });
    const client = new AuthServiceClient(baseUrl);
    await expect(client.getCoderToken("redirect")).rejects.toThrow();
    expect(protectedHandler).not.toHaveBeenCalled();
  });

  it.each([
    undefined,
    "",
    "replace-me",
    "g".repeat(64),
    "a".repeat(63),
  ])("refuses to start with missing or malformed service secret", (secret) => {
    vi.stubEnv("AUTH_SERVICE_SECRET", secret);
    expect(() => startServer(0)).toThrow("AUTH_SERVICE_SECRET must be exactly 64 hex characters");
  });
});
