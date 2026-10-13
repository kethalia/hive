import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const getRequestSession = vi.hoisted(() => vi.fn());
const getCoderClientForUser = vi.hoisted(() => vi.fn());
const spawn = vi.hoisted(() => vi.fn());
vi.mock("@/lib/auth/session", () => ({ getRequestSession }));
vi.mock("@/lib/coder/user-client", () => ({ getCoderClientForUser }));
vi.mock("node:child_process", () => ({ spawn }));

import { POST } from "@/app/api/workspaces/[workspaceId]/terminal/paste-assets/route";
import { TERMINAL_PASTE_MAX_ACTIVE_REQUESTS } from "@/lib/workspace/paste-admission";
import { TERMINAL_PASTE_REQUEST_TIMEOUT_MS } from "@/lib/workspace/paste-request";

const context = { params: Promise.resolve({ workspaceId: "workspace-1" }) };
const client = () => ({
  getBaseUrl: () => "https://coder.test",
  getSessionToken: () => "fixture-token",
  getWorkspaceAgentName: vi.fn().mockResolvedValue("workspace.agent"),
});
function request(signal?: AbortSignal) {
  const body = new FormData();
  body.append("files", new File(["bytes"], "file.txt"));
  return new Request("https://hive.test/upload", { method: "POST", body, signal });
}

const finishPending: (() => void)[] = [];
function stalledLookup() {
  let resolve!: (value: ReturnType<typeof client>) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<ReturnType<typeof client>>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  finishPending.push(() => resolve(client()));
  getCoderClientForUser.mockReturnValueOnce(promise);
  return { resolve, reject };
}

describe("credential lookup cancellation through the actual upload route/helper", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    vi.clearAllMocks();
    getRequestSession.mockResolvedValue({ user: { id: "user-1" } });
    getCoderClientForUser.mockReset().mockResolvedValue(client());
    spawn.mockImplementation(() => {
      const child = new EventEmitter();
      const stdin = Object.assign(new EventEmitter(), {
        end: vi.fn(() => queueMicrotask(() => child.emit("close", 0))),
      });
      const stderr = new EventEmitter();
      return Object.assign(child, { stdin, stderr, kill: vi.fn() });
    });
  });
  afterEach(async () => {
    finishPending.splice(0).forEach((finish) => {
      finish();
    });
    await vi.advanceTimersByTimeAsync(0);
    vi.useRealTimers();
  });

  it("returns 504 and releases upload admission while the credential store is still stalled", async () => {
    const stalled = stalledLookup();
    const response = POST(request(), context);
    await vi.waitFor(() => expect(getCoderClientForUser).toHaveBeenCalledOnce());
    await vi.advanceTimersByTimeAsync(TERMINAL_PASTE_REQUEST_TIMEOUT_MS);
    expect((await response).status).toBe(504);
    expect(spawn).not.toHaveBeenCalled();

    // The separate DB limit retains the pending query, while request admission is free.
    const retry = await POST(request(), context);
    expect(retry.status).toBe(429);
    expect(retry.headers.get("retry-after")).toBe("2");
    expect(getCoderClientForUser).toHaveBeenCalledOnce();
    getRequestSession.mockResolvedValue({ user: { id: "other-user" } });
    expect((await POST(request(), context)).status).toBe(200);
    expect(spawn).toHaveBeenCalledOnce();

    const lateClient = client();
    stalled.resolve(lateClient);
    await vi.advanceTimersByTimeAsync(0);
    expect(lateClient.getWorkspaceAgentName).not.toHaveBeenCalled();
    expect(spawn).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("returns 408 on disconnect and observes a later token-store rejection safely", async () => {
    const stalled = stalledLookup();
    const controller = new AbortController();
    const response = POST(request(controller.signal), context);
    await vi.waitFor(() => expect(getCoderClientForUser).toHaveBeenCalledOnce());
    controller.abort();
    expect((await response).status).toBe(408);
    stalled.reject(new Error("late database failure"));
    await vi.advanceTimersByTimeAsync(0);
    expect(spawn).not.toHaveBeenCalled();
    expect((await POST(request(), context)).status).toBe(200);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("bounds abandoned queries across users and admits new lookups once one actually settles", async () => {
    const stalled = Array.from({ length: TERMINAL_PASTE_MAX_ACTIVE_REQUESTS }, () =>
      stalledLookup(),
    );
    const responses: Promise<Response>[] = [];
    for (let i = 0; i < stalled.length; i++) {
      getRequestSession.mockResolvedValue({ user: { id: `user-${i}` } });
      responses.push(POST(request(), context));
      await vi.waitFor(() => expect(getCoderClientForUser).toHaveBeenCalledTimes(i + 1));
    }
    await vi.advanceTimersByTimeAsync(TERMINAL_PASTE_REQUEST_TIMEOUT_MS);
    for (const response of await Promise.all(responses)) expect(response.status).toBe(504);
    getRequestSession.mockResolvedValue({ user: { id: "new-user" } });
    expect((await POST(request(), context)).status).toBe(429);
    expect(getCoderClientForUser).toHaveBeenCalledTimes(TERMINAL_PASTE_MAX_ACTIVE_REQUESTS);
    const lateClient = client();
    stalled[0].resolve(lateClient);
    await vi.advanceTimersByTimeAsync(0);
    expect(lateClient.getWorkspaceAgentName).not.toHaveBeenCalled();
    expect((await POST(request(), context)).status).toBe(200);
    expect(getCoderClientForUser).toHaveBeenCalledTimes(TERMINAL_PASTE_MAX_ACTIVE_REQUESTS + 1);
    expect(spawn).toHaveBeenCalledOnce();
  });
});
