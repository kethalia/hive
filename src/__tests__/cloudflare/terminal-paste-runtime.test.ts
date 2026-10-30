import { SECURE_SESSION_COOKIE_NAME, signCookie } from "@hive/auth";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mock = vi.hoisted(() => ({ transfer: vi.fn() }));
vi.mock("../../../deploy/cloudflare/app/terminal-paste-transport", () => ({
  transferTerminalPaste: mock.transfer,
}));

import { readTerminalPasteFormData } from "@/lib/workspace/paste-request";
import {
  type TerminalPasteEnvironment,
  terminalPasteRuntime,
} from "../../../deploy/cloudflare/app/terminal-paste-runtime";

const origin = "https://hive.example",
  workspaceId = "10000000-0000-4000-8000-000000000001",
  agentId = "20000000-0000-4000-8000-000000000001",
  coderUserId = "30000000-0000-4000-8000-000000000001";
const path = `${origin}/api/workspaces/${workspaceId}/terminal/paste-assets`;
let env: TerminalPasteEnvironment,
  provider: ReturnType<typeof vi.fn<typeof fetch>>,
  auth: ReturnType<typeof vi.fn<typeof fetch>>;
function request(
  files: File[] = [new File([new Uint8Array([0, 255, 13, 10])], "../../unsafe name.bin")],
  headers: Record<string, string> = {},
) {
  const body = new FormData();
  for (const file of files) body.append("files", file);
  return new Request(path, {
    method: "POST",
    headers: {
      Origin: origin,
      Cookie: `${SECURE_SESSION_COOKIE_NAME}=${signCookie("session", env.COOKIE_SECRET ?? "")}`,
      ...headers,
    },
    body,
  });
}
beforeEach(() => {
  vi.stubEnv("NODE_ENV", "production");
  auth = vi.fn<typeof fetch>(async (input) =>
    String(input).endsWith("/token")
      ? Response.json({ token: "private", coderUrl: "https://coder.example", expiresAt: null })
      : Response.json({
          userId: "40000000-0000-4000-8000-000000000001",
          coderUserId,
          sessionId: "session",
          coderUrl: "https://coder.example",
          expiresAt: new Date(Date.now() + 3600000).toISOString(),
        }),
  );
  provider = vi.fn<typeof fetch>(async (input) =>
    String(input).endsWith("/users/me")
      ? Response.json({ id: coderUserId })
      : Response.json({
          id: workspaceId,
          owner_id: coderUserId,
          latest_build: {
            id: "50000000-0000-4000-8000-000000000001",
            status: "running",
            resources: [{ agents: [{ id: agentId, status: "connected" }] }],
          },
        }),
  );
  env = {
    HIVE_TERMINAL_PASTE_ENABLED: "true",
    HIVE_PREVIEW_ORIGIN: origin,
    CODER_URL: "https://coder.example",
    COOKIE_SECRET: "a".repeat(64),
    AUTH_SERVICE_SECRET: "b".repeat(64),
    AUTH_SERVICE: { fetch: auth },
  };
  mock.transfer
    .mockReset()
    .mockImplementation(async ({ files }) =>
      files.map(({ name }: { name: string }) => `/tmp/hive-terminal-paste/${name}`),
    );
});
afterEach(() => vi.unstubAllEnvs());
describe("ordinary clipboard Workers runtime", () => {
  it("preserves multipart bytes and generated safe paths after fresh owner checks", async () => {
    const res = await terminalPasteRuntime(request(), env, provider);
    expect(res.status).toBe(200);
    const args = mock.transfer.mock.calls[0][0];
    expect(args.files[0].bytes).toEqual(new Uint8Array([0, 255, 13, 10]));
    expect(args.files[0].name).toMatch(/^[a-f0-9-]{36}-..-..-unsafe-name.bin$/);
    expect(args.files[0].sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(args.agentId).toBe(agentId);
    expect((await res.json()).paths[0]).toMatch(/^\/tmp\/hive-terminal-paste\//);
    expect(provider).toHaveBeenCalledTimes(4);
  });
  it("flag, origin and unauthenticated input fail before any PTY effect", async () => {
    expect(
      (
        await terminalPasteRuntime(
          request(),
          { ...env, HIVE_TERMINAL_PASTE_ENABLED: "false" },
          provider,
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await terminalPasteRuntime(
          request(undefined, { Origin: "https://other.example" }),
          env,
          provider,
        )
      ).status,
    ).toBe(403);
    expect(
      (await terminalPasteRuntime(request(undefined, { Cookie: "" }), env, provider)).status,
    ).toBe(401);
    expect(mock.transfer).not.toHaveBeenCalled();
    expect(provider).not.toHaveBeenCalled();
  });
  it("revoked session never reads or writes a workspace", async () => {
    auth.mockResolvedValue(new Response(null, { status: 404 }));
    expect((await terminalPasteRuntime(request(), env, provider)).status).toBe(401);
    expect(provider).not.toHaveBeenCalled();
    expect(mock.transfer).not.toHaveBeenCalled();
  });
  it("foreign owner cannot choose an execution target", async () => {
    provider.mockImplementation(async () =>
      Response.json({
        id: workspaceId,
        owner_id: "60000000-0000-4000-8000-000000000001",
        latest_build: { id: workspaceId, status: "running", resources: [] },
      }),
    );
    expect((await terminalPasteRuntime(request(), env, provider)).status).toBe(403);
    expect(mock.transfer).not.toHaveBeenCalled();
  });
  it("ambiguous agents fail rather than picking the first workspace process", async () => {
    provider.mockImplementation(async (input) =>
      String(input).endsWith("/users/me")
        ? Response.json({ id: coderUserId })
        : Response.json({
            id: workspaceId,
            owner_id: coderUserId,
            latest_build: {
              id: workspaceId,
              status: "running",
              resources: [
                {
                  agents: [
                    { id: agentId, status: "connected" },
                    { id: workspaceId, status: "connected" },
                  ],
                },
              ],
            },
          }),
    );
    expect((await terminalPasteRuntime(request(), env, provider)).status).toBe(409);
    expect(mock.transfer).not.toHaveBeenCalled();
  });
  it.each([11, 0])("rejects invalid file count %s", async (count) => {
    const files = Array.from({ length: count }, () => new File(["x"], "x"));
    expect((await terminalPasteRuntime(request(files), env, provider)).status).toBe(
      count > 10 ? 413 : 400,
    );
    expect(mock.transfer).not.toHaveBeenCalled();
  });
  it("keeps the10MiB per-file ceiling", async () => {
    expect(
      (
        await terminalPasteRuntime(
          request([new File([new Uint8Array(10 * 1024 * 1024 + 1)], "large")]),
          env,
          provider,
        )
      ).status,
    ).toBe(413);
    expect(mock.transfer).not.toHaveBeenCalled();
  });
  it("rejects a second upload while an uncertain first transport still owns its slot", async () => {
    let release!: (value: string[]) => void;
    mock.transfer.mockImplementationOnce(
      () =>
        new Promise((done) => {
          release = done;
        }),
    );
    const first = terminalPasteRuntime(request(), env, provider);
    await vi.waitFor(() => expect(mock.transfer).toHaveBeenCalledOnce());
    expect((await terminalPasteRuntime(request(), env, provider)).status).toBe(429);
    release([]);
    expect((await first).status).toBe(200);
    expect((await terminalPasteRuntime(request(), env, provider)).status).toBe(200);
  });
  it("stalled multipart read and uncancellable body still obey caller abort", async () => {
    const controller = new AbortController();
    const cancel = vi.fn(() => new Promise<void>(() => {}));
    const body = new ReadableStream<Uint8Array>({ cancel });
    const req = new Request(path, {
      method: "POST",
      headers: { "Content-Type": "multipart/form-data; boundary=test" },
      body,
      duplex: "half",
    } as RequestInit);
    const task = readTerminalPasteFormData(req, controller.signal);
    controller.abort();
    await expect(task).rejects.toBeDefined();
    expect(cancel).toHaveBeenCalled();
  });
});
