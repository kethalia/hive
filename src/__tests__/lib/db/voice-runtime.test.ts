import { generateKeyPairSync, randomUUID } from "node:crypto";
import { SECURE_SESSION_COOKIE_NAME, signCookie } from "@hive/auth";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  getUser: vi.fn(),
  binding: vi.fn(),
  open: vi.fn(),
  dbClose: vi.fn(),
  coder: vi.fn(),
}));
vi.mock("@hive/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@hive/auth")>();
  return {
    ...actual,
    AuthServiceClient: class {
      getSession = mocks.getSession;
    },
  };
});
vi.mock("@hive/db", () => ({ getDb: () => ({ user: { findUnique: mocks.getUser } }) }));
vi.mock("@hive/db/cloudflare", () => ({
  createCloudflareDatabaseRequest: () => ({
    run: (fn: () => unknown) => fn(),
    close: mocks.dbClose,
  }),
}));
vi.mock("@/lib/coder/user-client", () => ({ getCoderClientForUser: mocks.coder }));
vi.mock("@/lib/codex-session/registration.server", () => ({
  resolveVerifiedWorkspaceHost: mocks.binding,
}));
vi.mock("@/lib/codex/voice-portable-client.server", () => ({
  openPortableVoiceClient: mocks.open,
}));

import { voiceRuntime } from "../../../../deploy/cloudflare/app/voice-runtime";

const workspaceId = randomUUID(),
  userId = randomUUID(),
  coderUserId = randomUUID(),
  templateId = randomUUID(),
  threadId = randomUUID(),
  session = randomUUID();
const secret = "a".repeat(64),
  origin = "https://hive.example",
  coderOrigin = "https://coder.example";
const key = generateKeyPairSync("ed25519")
  .privateKey.export({ type: "pkcs8", format: "pem" })
  .toString();
const binding = {
  coderOrigin,
  hiveUserId: userId,
  ownerId: coderUserId,
  workspaceId,
  buildId: randomUUID(),
  agentId: randomUUID(),
  templateId,
  appOrigin: "https://voice.example",
  appId: randomUUID(),
};
const env = {
  DATABASE_URL: "postgres://fixture",
  AUTH_SERVICE: { fetch },
  AUTH_SERVICE_SECRET: secret,
  COOKIE_SECRET: secret,
  CODER_URL: coderOrigin,
  HIVE_PREVIEW_ORIGIN: origin,
  HIVE_CODEX_VOICE_ENABLED: "true",
  HIVE_VOICE_TRANSPORT: "workspace-app",
  HIVE_VOICE_ISSUER_PRIVATE_KEY: key,
  HIVE_VOICE_ISSUER_KEY_ID: "test",
  HIVE_VOICE_TEMPLATE_PINS_JSON: JSON.stringify([{ templateId, manifestSha256: "a".repeat(64) }]),
};
function request(method: "GET" | "POST") {
  return new Request(`${origin}/api/workspaces/${workspaceId}/voice`, {
    method,
    headers: {
      Cookie: `${SECURE_SESSION_COOKIE_NAME}=${signCookie(session, secret)}`,
      ...(method === "POST" ? { Origin: origin, "Content-Type": "application/json" } : {}),
    },
    ...(method === "POST" ? { body: JSON.stringify({ threadId, sdp: "v=0\r\nm=audio" }) } : {}),
  });
}
function setup() {
  mocks.getSession.mockResolvedValue({
    sessionId: session,
    userId,
    coderUserId,
    coderUrl: coderOrigin,
    expiresAt: new Date(Date.now() + 3600000).toISOString(),
  });
  mocks.getUser.mockResolvedValue({ coderUserId });
  mocks.coder.mockResolvedValue({});
  mocks.binding.mockResolvedValue({ binding });
  mocks.dbClose.mockResolvedValue(undefined);
  let disposed = false;
  const rpc = {
    onClose: () => {},
    onNotification: (_: unknown) => {},
    request: vi.fn(async (method: string) =>
      method === "thread/loaded/list"
        ? { data: [threadId] }
        : method === "thread/read"
          ? { thread: { id: threadId, cwd: "/project" } }
          : {},
    ),
    close: vi.fn(() => {
      if (!disposed) {
        disposed = true;
        dispose();
        rpc.onClose();
      }
    }),
  };
  let dispose = () => {};
  mocks.open.mockImplementation(async (...args: unknown[]) => {
    dispose = args[6] as () => void;
    return rpc;
  });
  const tasks: Promise<unknown>[] = [];
  return {
    rpc,
    tasks,
    context: {
      waitUntil: (promise: Promise<unknown>) => {
        tasks.push(promise);
      },
    },
  };
}
afterEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
});
describe("voice Worker route", () => {
  it("stays disabled without explicit transport configuration", async () => {
    const f = setup();
    expect(
      (
        await voiceRuntime(
          request("GET"),
          { ...env, HIVE_VOICE_TRANSPORT: undefined },
          Date.now() + 60000,
          f.context,
        )
      ).status,
    ).toBe(503);
    expect(mocks.open).not.toHaveBeenCalled();
  });
  it("authenticates and rechecks ownership before listing threads", async () => {
    const f = setup();
    const response = await voiceRuntime(request("GET"), env, Date.now() + 60000, f.context);
    expect(response.status).toBe(200);
    expect((await response.json()).threads).toHaveLength(1);
    expect(mocks.getSession).toHaveBeenCalledTimes(2);
    expect(mocks.binding).toHaveBeenCalledTimes(2);
    expect(mocks.dbClose).toHaveBeenCalledTimes(2);
    await Promise.all(f.tasks);
  });
  it("closes active voice when session reauthorization fails", async () => {
    vi.useFakeTimers();
    const f = setup();
    const response = await voiceRuntime(request("POST"), env, Date.now() + 60000, f.context);
    expect(response.status).toBe(200);
    mocks.getSession.mockResolvedValueOnce(null);
    await vi.advanceTimersByTimeAsync(20000);
    expect(f.rpc.request).toHaveBeenCalledWith("thread/realtime/stop", { threadId }, 3000);
    const stopIndex = f.rpc.request.mock.calls.findIndex(
      ([method]) => method === "thread/realtime/stop",
    );
    expect(f.rpc.request.mock.invocationCallOrder[stopIndex]).toBeLessThan(
      f.rpc.close.mock.invocationCallOrder[0],
    );
    expect(f.rpc.close).toHaveBeenCalled();
    await Promise.all(f.tasks);
    await response.body?.cancel();
  });
  it("stops the call before closing at the preview deadline", async () => {
    vi.useFakeTimers();
    const f = setup();
    const response = await voiceRuntime(request("POST"), env, Date.now() + 500, f.context);
    expect(response.status).toBe(200);
    await vi.advanceTimersByTimeAsync(500);
    const stopIndex = f.rpc.request.mock.calls.findIndex(
      ([method]) => method === "thread/realtime/stop",
    );
    expect(stopIndex).toBeGreaterThanOrEqual(0);
    expect(f.rpc.request.mock.invocationCallOrder[stopIndex]).toBeLessThan(
      f.rpc.close.mock.invocationCallOrder[0],
    );
    await Promise.all(f.tasks);
    await response.body?.cancel();
  });
  it("refuses a changed workspace binding before listing", async () => {
    const f = setup();
    mocks.binding
      .mockResolvedValueOnce({ binding })
      .mockResolvedValueOnce({ binding: { ...binding, buildId: randomUUID() } });
    const response = await voiceRuntime(request("GET"), env, Date.now() + 60000, f.context);
    expect(response.status).toBe(502);
    expect(f.rpc.request).not.toHaveBeenCalled();
    expect(f.rpc.close).toHaveBeenCalled();
    await Promise.all(f.tasks);
  });
  it("rejects a cross-site offer before touching the workspace", async () => {
    const f = setup(),
      base = request("POST"),
      headers = new Headers(base.headers);
    headers.set("Origin", "https://attacker.example");
    const response = await voiceRuntime(
      new Request(base, { headers }),
      env,
      Date.now() + 60000,
      f.context,
    );
    expect(response.status).toBe(403);
    expect(mocks.getSession).not.toHaveBeenCalled();
  });
  it("releases its lifetime when the browser cancels the stream", async () => {
    const f = setup();
    const response = await voiceRuntime(request("POST"), env, Date.now() + 60000, f.context);
    expect(response.status).toBe(200);
    await response.body?.cancel();
    await Promise.all(f.tasks);
    expect(f.rpc.request).toHaveBeenCalledWith("thread/realtime/stop", { threadId }, 3000);
    expect(f.rpc.close).toHaveBeenCalled();
  });
  it("enforces the attachment cap after concurrent request bodies complete", async () => {
    const f = setup(),
      controls: ReadableStreamDefaultController<Uint8Array>[] = [];
    mocks.open.mockImplementation(async (...args: unknown[]) => {
      const dispose = args[6] as () => void;
      let closed = false;
      const rpc = {
        onClose: () => {},
        onNotification: () => {},
        request: vi.fn(async (method: string) =>
          method === "thread/loaded/list"
            ? { data: [threadId] }
            : method === "thread/read"
              ? { thread: { id: threadId, cwd: "/project" } }
              : {},
        ),
        close: () => {
          if (!closed) {
            closed = true;
            dispose();
            rpc.onClose();
          }
        },
      };
      return rpc;
    });
    const pending = Array.from({ length: 5 }, () => {
      const base = request("POST");
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controls.push(controller);
        },
      });
      const incoming = new Request(base.url, {
        method: "POST",
        headers: base.headers,
        body: stream,
        duplex: "half",
      } as RequestInit);
      return voiceRuntime(incoming, env, Date.now() + 60000, f.context);
    });
    for (const controller of controls) {
      controller.enqueue(
        new TextEncoder().encode(JSON.stringify({ threadId, sdp: "v=0\r\nm=audio" })),
      );
      controller.close();
    }
    const responses = await Promise.all(pending);
    expect(responses.map((r) => r.status).sort()).toEqual([200, 200, 200, 200, 503]);
    await Promise.all(responses.filter((r) => r.status === 200).map((r) => r.body?.cancel()));
    await Promise.all(f.tasks);
  });
});
