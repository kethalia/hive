import { createCloneTerminalProof, createTerminalTicket } from "@hive/auth";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCloneSessionKey, createSafeCloneTerminalSessionName } from "@/lib/git/clone-tree";
import type { RelaySocket } from "@/lib/terminal/relay-types";
import { parseGenericTerminalTarget } from "../../../deploy/cloudflare/app/generic-terminal-relay";
import {
  createGenericTerminalDependencies,
  genericTerminalRelay,
} from "../../../deploy/cloudflare/app/generic-terminal-runtime";

const origin = "https://hive.example",
  coder = "https://coder.example";
const userId = "10000000-0000-4000-8000-000000000001",
  coderId = "20000000-0000-4000-8000-000000000001",
  workspaceId = "30000000-0000-4000-8000-000000000001",
  agentId = "40000000-0000-4000-8000-000000000001",
  buildId = "50000000-0000-4000-8000-000000000001";
const query = new URLSearchParams({
  workspaceId,
  agentId,
  reconnectId: "60000000-0000-4000-8000-000000000001",
  sessionName: "shell",
  width: "80",
  height: "24",
}).toString();
function fixture() {
  const url = `${origin}/ws?${query}`;
  const cookieSecret = "synthetic-cookie-secret";
  const ticket = createTerminalTicket(
    {
      sessionId: "fixture-session",
      audience: "hive.example",
      origin,
      requestTarget: `/ws?${query}`,
    },
    cookieSecret,
    Date.now() + 3600000,
  );
  const request = new Request(url, {
    headers: {
      Origin: origin,
      Upgrade: "websocket",
      "Sec-WebSocket-Protocol": `hive-terminal-v1, hive-ticket.${ticket}`,
    },
  });
  const session = {
    userId,
    coderUserId: coderId,
    sessionId: "fixture-session",
    coderUrl: coder,
    expiresAt: new Date(Date.now() + 3600000).toISOString(),
  };
  const credential: {
    token: unknown;
    coderUrl: string;
    expiresAt: string | null;
  } = {
    token: "synthetic-coder-token",
    coderUrl: coder,
    expiresAt: null,
  };
  const workspace = {
    id: workspaceId,
    owner_id: coderId,
    latest_build: {
      id: buildId,
      status: "running",
      resources: [{ agents: [{ id: agentId, status: "connected" }] }],
    },
  };
  const workspaceReply: { value: unknown } = { value: workspace };
  const auth = vi.fn<typeof fetch>(async (input, init) => {
    expect(new Headers(init?.headers).get("Authorization")).toBe(`Bearer ${"a".repeat(64)}`);
    expect(init?.redirect).toBe("manual");
    const path = new URL(String(input)).pathname;
    if (path === "/sessions/fixture-session") return Response.json(session);
    if (path === "/sessions/fixture-session/token") return Response.json(credential);
    throw new Error("Unexpected private service path");
  });
  const provider = vi.fn<typeof fetch>(async (input, init) => {
    expect(new Headers(init?.headers).get("Coder-Session-Token")).toBe("synthetic-coder-token");
    expect(new Headers(init?.headers).get("Authorization")).toBeNull();
    expect(new Headers(init?.headers).has("Cookie")).toBe(false);
    expect(init?.redirect).toBe("manual");
    const path = new URL(String(input)).pathname;
    if (path === "/api/v2/users/me") return Response.json({ id: coderId });
    if (path === `/api/v2/workspaces/${workspaceId}`) return Response.json(workspaceReply.value);
    if (path.endsWith("/extend")) return new Response(null, { status: 304 });
    throw new Error("Unexpected provider path");
  });
  const env = {
    HIVE_GENERIC_TERMINAL_ENABLED: "true",
    HIVE_PUBLIC_ORIGIN: origin,
    CODER_URL: coder,
    COOKIE_SECRET: cookieSecret,
    AUTH_SERVICE_SECRET: "a".repeat(64),
    AUTH_SERVICE: { fetch: auth },
  };
  const options = {
    fetch: provider,
    pair: (): { client: RelaySocket; server: RelaySocket } => {
      throw new Error("No socket needed by authorization");
    },
    response: () => new Response(),
    trackCleanup: vi.fn(),
    onClosed: vi.fn(),
  };
  const deps = createGenericTerminalDependencies(request, env, options);
  const target = parseGenericTerminalTarget(new URL(url));
  if (!target) throw new Error("Fixture target");
  const authorize = () => deps.authorize(request, target, new AbortController().signal);
  return {
    request,
    session,
    credential,
    workspace,
    workspaceReply,
    auth,
    provider,
    env,
    options,
    deps,
    target,
    authorize,
  };
}
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});
describe("fixed private terminal authorization", () => {
  it("constructs diagnostics only from the injected sibling factory without opening a client", async () => {
    const f = fixture();
    const factory = vi.fn(() => {
      throw new Error("synthetic lazy factory");
    });
    expect(f.deps.diagnostics).toBeUndefined();
    const deps = createGenericTerminalDependencies(
      f.request,
      f.env,
      f.options,
      "hive-terminal-v1",
      factory,
    );
    const hooks = deps.diagnostics!(await f.authorize(), f.target);
    expect(factory).not.toHaveBeenCalled();
    await expect(hooks.open()).rejects.toThrow("synthetic lazy factory");
    expect(factory).toHaveBeenCalledOnce();
    expect(factory).toHaveBeenCalledWith({
      queryTimeoutMillis: 5000,
      transactionTimeoutMillis: 5000,
    });
  });

  it("rejects a clone proof that expires during fresh private authorization", async () => {
    vi.useFakeTimers();
    const f = fixture(),
      clonePath = "projects/owner/repo";
    const sessionName = createSafeCloneTerminalSessionName(
      createCloneSessionKey(clonePath.split("/")),
    );
    const proof = createCloneTerminalProof(
      { workspaceId, agentId, sessionId: "fixture-session", sessionName, clonePath, ttlMs: 1 },
      f.env.COOKIE_SECRET,
    );
    const parsed = new URLSearchParams(query);
    parsed.set("sessionName", sessionName);
    parsed.set("clonePath", clonePath);
    parsed.set("cloneProof", proof);
    const requestTarget = `/ws?${parsed}`;
    const ticket = createTerminalTicket(
      { sessionId: "fixture-session", audience: "hive.example", origin, requestTarget },
      f.env.COOKIE_SECRET,
      Date.now() + 3600000,
    );
    const request = new Request(`${origin}${requestTarget}`, {
      headers: {
        Origin: origin,
        Upgrade: "websocket",
        "Sec-WebSocket-Protocol": `hive-terminal-v1, hive-ticket.${ticket}`,
      },
    });
    const original = f.auth.getMockImplementation()!;
    f.auth.mockImplementation(async (input, init) => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      return original(input, init);
    });
    const deps = createGenericTerminalDependencies(request, f.env, f.options);
    const check = expect(
      deps.authorize(
        request,
        parseGenericTerminalTarget(new URL(request.url))!,
        new AbortController().signal,
      ),
    ).rejects.toThrow("clone proof");
    await vi.advanceTimersByTimeAsync(10);
    await check;
  });

  it.each([
    "valid",
    "session",
    "workspace",
    "agent",
    "expired",
    "signature",
  ])("validates clone proof %s against the captured ticket session before provider admission", async (kind) => {
    const f = fixture(),
      clonePath = "projects/owner/repo";
    const sessionName = createSafeCloneTerminalSessionName(
      createCloneSessionKey(clonePath.split("/")),
    );
    const proof = createCloneTerminalProof(
      {
        workspaceId: kind === "workspace" ? userId : workspaceId,
        agentId: kind === "agent" ? userId : agentId,
        sessionId: kind === "session" ? "different-session" : "fixture-session",
        sessionName,
        clonePath,
        ...(kind === "expired" ? { nowMs: Date.now() - 3600000 } : {}),
      },
      kind === "signature" ? "different-secret" : f.env.COOKIE_SECRET,
    );
    const parsed = new URLSearchParams(query);
    parsed.set("sessionName", sessionName);
    parsed.set("clonePath", clonePath);
    parsed.set("cloneProof", proof);
    const requestTarget = `/ws?${parsed}`;
    const ticket = createTerminalTicket(
      { sessionId: "fixture-session", audience: "hive.example", origin, requestTarget },
      f.env.COOKIE_SECRET,
      Date.now() + 3600000,
    );
    const request = new Request(`${origin}${requestTarget}`, {
      headers: {
        Origin: origin,
        Upgrade: "websocket",
        "Sec-WebSocket-Protocol": `hive-terminal-v1, hive-ticket.${ticket}`,
      },
    });
    if (kind !== "valid") {
      expect(() => createGenericTerminalDependencies(request, f.env, f.options)).toThrow(
        "clone proof",
      );
      expect(f.auth).not.toHaveBeenCalled();
      expect(f.provider).not.toHaveBeenCalled();
      return;
    }
    const deps = createGenericTerminalDependencies(request, f.env, f.options);
    const target = parseGenericTerminalTarget(new URL(request.url))!;
    expect(await deps.authorize(request, target, new AbortController().signal)).toMatchObject({
      userId,
      coderUserId: coderId,
      buildId,
    });
  });

  it("observes one real extension outcome including bounded manual-shutdown response", async () => {
    const f = fixture();
    const authority = await f.authorize();
    f.provider.mockImplementation(async (input) => {
      expect(String(input)).toContain("/extend");
      return Response.json(
        { message: "Workspace shutdown is manual", private: "synthetic-secret" },
        { status: 409 },
      );
    });
    expect(await f.deps.extend(authority, f.target, new AbortController().signal)).toMatchObject({
      ok: false,
      httpStatus: 409,
      category: "manual-shutdown",
    });
    expect(
      f.provider.mock.calls.filter(([input]) => String(input).includes("/extend")),
    ).toHaveLength(1);
  });

  it("binds audio subprotocol admission to the signed exact audio target and captured owner", async () => {
    const f = fixture();
    const audioTarget = `/ws/audio?${new URLSearchParams({ workspaceId, agentId, sessionName: "shell" })}`;
    const ticket = createTerminalTicket(
      {
        sessionId: "fixture-session",
        audience: "hive.example",
        origin,
        requestTarget: audioTarget,
      },
      f.env.COOKIE_SECRET,
      Date.now() + 3600000,
    );
    const request = new Request(`${origin}${audioTarget}`, {
      headers: {
        Origin: origin,
        Upgrade: "websocket",
        "Sec-WebSocket-Protocol": `hive-audio-v1, hive-ticket.${ticket}`,
      },
    });
    const deps = createGenericTerminalDependencies(request, f.env, f.options, "hive-audio-v1");
    expect(await deps.authorize(request, f.target, new AbortController().signal)).toMatchObject({
      userId,
      coderUserId: coderId,
      buildId,
    });
    expect(() => createGenericTerminalDependencies(request, f.env, f.options)).toThrow("ticket");
    const substituted = new Request(
      `${origin}${audioTarget.replace("shell", "different")}`,
      request,
    );
    expect(() =>
      createGenericTerminalDependencies(substituted, f.env, f.options, "hive-audio-v1"),
    ).toThrow("ticket");
  });

  it.each([
    [401, 4401],
    [403, 4403],
  ])("classifies upstream %s as terminal %s without shared-account mutation", async (status, closeCode) => {
    const f = fixture();
    f.provider.mockResolvedValue(new Response("private provider detail", { status }));
    await expect(f.authorize()).rejects.toMatchObject({ closeCode });
    expect(
      f.auth.mock.calls.every(
        ([input, init]) =>
          init?.method === undefined && String(input).includes("/sessions/fixture-session"),
      ),
    ).toBe(true);
  });
  it("preserves password session credentials through exact owner reads and extension", async () => {
    const f = fixture();
    const authority = await f.authorize();
    expect(authority.token).toBe("synthetic-coder-token");
    await f.deps.extend(authority, f.target, new AbortController().signal);
    expect(f.provider).toHaveBeenCalledTimes(3);
  });
  it("bounds delayed private token lookup before owner reads", async () => {
    vi.useFakeTimers();
    const f = fixture();
    const original = f.auth.getMockImplementation()!;
    f.auth.mockImplementation(async (input, init) => {
      if (String(input).endsWith("/token"))
        await new Promise((resolve) => setTimeout(resolve, 15000));
      return original(input, init);
    });
    const work = f.authorize();
    await vi.advanceTimersByTimeAsync(15000);
    expect(await work).toMatchObject({ token: "synthetic-coder-token" });
  });
  it("uses the public production origin for ticket binding and rejects origin substitution", async () => {
    const f = fixture();
    const production = {
      ...f.env,
      HIVE_PUBLIC_ORIGIN: origin,
    };
    const deps = createGenericTerminalDependencies(f.request, production, f.options);
    expect(await deps.authorize(f.request, f.target, new AbortController().signal)).toMatchObject({
      userId,
      buildId,
    });
    expect(() =>
      createGenericTerminalDependencies(
        f.request,
        { ...production, HIVE_PUBLIC_ORIGIN: "https://wrong.example" },
        f.options,
      ),
    ).toThrow();
  });
  it("independently binds session/token/API subject/current build/agent and keeps one token for both reads", async () => {
    const f = fixture();
    expect(await f.authorize()).toMatchObject({
      userId,
      coderUserId: coderId,
      buildId,
      coderOrigin: coder,
    });
    expect(f.auth).toHaveBeenCalledTimes(2);
    expect(f.provider).toHaveBeenCalledTimes(2);
    await f.deps.extend(await f.authorize(), f.target, new AbortController().signal);
  });
  it("authorizes the observed eight-resource shape with agentless environment and PVC resources", async () => {
    const f = fixture();
    f.workspaceReply.value = {
      ...f.workspace,
      latest_build: {
        ...f.workspace.latest_build,
        resources: [
          {
            type: "kubernetes_deployment_v1",
            name: "workspace",
            agents: [{ id: agentId, status: "connected" }],
          },
          ...Array.from({ length: 6 }, (_, index) => ({
            type: "coder_env",
            name: `fixture-env-${index}`,
          })),
          { type: "kubernetes_persistent_volume_claim_v1", name: "home" },
        ],
      },
    };
    expect(await f.authorize()).toMatchObject({ userId, coderUserId: coderId, buildId, agentId });
    expect(f.provider).toHaveBeenCalledTimes(2);
  });
  it.each([
    ["no selected agent", [{ type: "coder_env" }, { agents: [] }]],
    [
      "duplicate selected agent",
      [
        { agents: [{ id: agentId, status: "connected" }] },
        { agents: [{ id: agentId, status: "connected" }] },
      ],
    ],
    ["disconnected agent", [{ agents: [{ id: agentId, status: "disconnected" }] }]],
    ["null agents", [{ agents: null }]],
    ["object agents", [{ agents: {} }]],
    ["string agents", [{ agents: "invalid" }]],
    ["null agent member", [{ agents: [null] }]],
    ["malformed agent member", [{ agents: [{ id: agentId, status: 1 }] }]],
    [
      "too many resources",
      [
        { agents: [{ id: agentId, status: "connected" }] },
        ...Array.from({ length: 100 }, () => ({})),
      ],
    ],
    [
      "too many agents",
      [
        {
          agents: [
            { id: agentId, status: "connected" },
            ...Array.from({ length: 100 }, (_, index) => ({
              id: `70000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
              status: "connected",
            })),
          ],
        },
      ],
    ],
  ])("rejects %s without treating malformed resources as agentless", async (_kind, resources) => {
    const f = fixture();
    f.workspaceReply.value = {
      ...f.workspace,
      latest_build: { ...f.workspace.latest_build, resources },
    };
    await expect(f.authorize()).rejects.toThrow();
    expect(f.provider.mock.calls.every(([url]) => !String(url).includes("/pty"))).toBe(true);
  });
  it.each([
    "owner",
    "agent",
    "expiry",
    "token",
    "origin",
  ])("rejects %s substitution before opening any PTY", async (kind) => {
    const f = fixture();
    if (kind === "owner") f.workspace.owner_id = userId;
    if (kind === "agent") f.workspace.latest_build.resources[0].agents[0].id = userId;
    if (kind === "expiry") f.session.expiresAt = "invalid";
    if (kind === "token") f.credential.token = { token: "invalid" };
    if (kind === "origin") f.credential.coderUrl = "https://elsewhere.example";
    await expect(f.authorize()).rejects.toThrow();
    expect(f.provider.mock.calls.every(([url]) => !String(url).includes("/pty"))).toBe(true);
  });
  it("ticket target/expiry is admission-only, not a current session bypass", async () => {
    vi.useFakeTimers();
    const f = fixture();
    await vi.advanceTimersByTimeAsync(31000);
    expect(() => createGenericTerminalDependencies(f.request, f.env, f.options)).toThrow();
    expect(await f.authorize()).toMatchObject({ userId });
    f.session.expiresAt = new Date(Date.now() - 1).toISOString();
    await expect(f.authorize()).rejects.toThrow();
    const changed = new Request(f.request.url.replace("width=80", "width=81"), f.request);
    expect(() => createGenericTerminalDependencies(changed, f.env, f.options)).toThrow();
  });
  it("rejects auth redirects, wrong Coder API subject and missing explicit service secret", async () => {
    const f = fixture();
    f.auth.mockResolvedValueOnce(
      new Response(null, { status: 307, headers: { Location: "https://elsewhere.example" } }),
    );
    await expect(f.authorize()).rejects.toThrow();
    f.provider.mockImplementationOnce(async () => Response.json({ id: userId }));
    await expect(f.authorize()).rejects.toThrow();
    vi.stubEnv("AUTH_SERVICE_SECRET", "b".repeat(64));
    expect(() =>
      createGenericTerminalDependencies(
        f.request,
        { ...f.env, AUTH_SERVICE_SECRET: undefined },
        f.options,
      ),
    ).toThrow();
  });
  it("aborts an auth body that stalls after response headers", async () => {
    const f = fixture(),
      controller = new AbortController();
    let cancelled = false;
    f.auth.mockImplementation(
      async () =>
        new Response(
          new ReadableStream({
            pull() {},
            cancel() {
              cancelled = true;
            },
          }),
        ),
    );
    const work = f.deps.authorize(f.request, f.target, controller.signal);
    const rejected = expect(work).rejects.toThrow();
    await new Promise((r) => setTimeout(r, 5));
    controller.abort();
    await rejected;
    expect(cancelled).toBe(true);
    expect(f.provider).not.toHaveBeenCalled();
  });
  it("default off fails before bindings and never selects the Node origin", async () => {
    const f = fixture();
    const response = await genericTerminalRelay(
      f.request,
      { ...f.env, HIVE_GENERIC_TERMINAL_ENABLED: "false" },
      Date.now() + 1000,
      { waitUntil: vi.fn() },
    );
    expect(response.status).toBe(404);
    expect(f.auth).not.toHaveBeenCalled();
    expect(f.provider).not.toHaveBeenCalled();
  });
  it("retains authorization lifetime until a parallel private read settles after its sibling fails", async () => {
    const f = fixture();
    let finish!: (response: Response) => void;
    const delayed = new Promise<Response>((r) => {
      finish = r;
    });
    f.auth.mockImplementation(async (input) =>
      String(input).endsWith("/token") ? new Response(null, { status: 307 }) : delayed,
    );
    let settled = false;
    const work = f.authorize();
    const rejected = expect(work).rejects.toThrow();
    void work.catch(() => {
      settled = true;
    });
    await new Promise((r) => setTimeout(r, 5));
    expect(settled).toBe(false);
    finish(Response.json(f.session));
    await rejected;
    expect(f.provider).not.toHaveBeenCalled();
  });
  it("closes a late upgraded socket after an ignored handshake abort", async () => {
    const f = fixture(),
      controller = new AbortController();
    const socket = {
      readyState: 1,
      accept: vi.fn(),
      close: vi.fn(),
      send: vi.fn(),
      addEventListener() {},
      removeEventListener() {},
    } satisfies RelaySocket;
    let finish!: (response: Response) => void;
    f.provider.mockImplementationOnce(
      () =>
        new Promise((r) => {
          finish = r;
        }),
    );
    const work = f.deps.upgrade("https://coder.example/fixed-test-upgrade", {
      signal: controller.signal,
    });
    const rejected = expect(work).rejects.toThrow();
    controller.abort();
    await rejected;
    const response = new Response(null);
    Object.defineProperty(response, "status", { value: 101 });
    Object.defineProperty(response, "webSocket", { value: socket });
    finish(response);
    await new Promise((r) => setTimeout(r, 5));
    expect(socket.close).toHaveBeenCalledWith(1008, "Terminal connection expired");
  });
});
