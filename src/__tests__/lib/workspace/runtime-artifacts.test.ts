import { readFile } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ fetch: vi.fn<typeof fetch>() }));
vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: () => ({ env: { ASSETS: { fetch: mocks.fetch } } }),
}));

import { readRuntimeArtifact } from "@/lib/workspace/runtime-artifacts.server";

const path = "scripts/notifications/agent-hook.py";
beforeEach(() => {
  vi.stubEnv("HIVE_RUNTIME_TARGET", "cloudflare");
  mocks.fetch.mockReset();
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});
describe("pinned runtime artifacts", () => {
  it("loads exact pinned bytes and rejects paths outside the manifest before fetch", async () => {
    const bytes = await readFile(path);
    mocks.fetch.mockResolvedValue(new Response(bytes));
    expect(await readRuntimeArtifact(path)).toBe(bytes.toString());
    for (const invalid of [
      "../scripts/notifications/agent-hook.py",
      "scripts/notifications/../agent-hook.py",
      "toString",
    ])
      await expect(readRuntimeArtifact(invalid)).rejects.toThrow("unavailable");
    expect(mocks.fetch).toHaveBeenCalledOnce();
  });
  it.each(["short", "tampered", "oversized"])("rejects %s bytes", async (mode) => {
    const bytes = await readFile(path),
      value =
        mode === "short"
          ? bytes.subarray(1)
          : mode === "oversized"
            ? Buffer.concat([bytes, Buffer.from("x")])
            : Buffer.from(bytes);
    if (mode === "tampered") value[0] ^= 1;
    mocks.fetch.mockResolvedValue(new Response(value));
    await expect(readRuntimeArtifact(path)).rejects.toThrow(/integrity|limit/);
  });
  it("bounds a stalled fetch and cancels its late response", async () => {
    const controller = new AbortController();
    vi.spyOn(AbortSignal, "timeout").mockReturnValue(controller.signal);
    let finish!: (r: Response) => void;
    mocks.fetch.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const work = readRuntimeArtifact(path);
    const settled = work.then(
      () => "success",
      () => "rejected",
    );
    controller.abort();
    expect(
      await Promise.race([
        settled,
        new Promise((resolve) => setTimeout(() => resolve("stalled"), 30)),
      ]),
    ).toBe("rejected");
    const cancel = vi.fn();
    finish(new Response(new ReadableStream({ cancel })));
    await vi.waitFor(() => expect(cancel).toHaveBeenCalledOnce());
    expect(mocks.fetch.mock.calls[0][1]?.signal).toBe(controller.signal);
  });
  it("uses one deadline across fetch and body", async () => {
    const controller = new AbortController();
    const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(controller.signal);
    const cancel = vi.fn();
    mocks.fetch.mockResolvedValue(new Response(new ReadableStream({ cancel })));
    const work = readRuntimeArtifact(path);
    const rejected = expect(work).rejects.toThrow(/deadline|aborted/);
    await Promise.resolve();
    controller.abort();
    await rejected;
    expect(timeout).toHaveBeenCalledTimes(1);
    expect(timeout).toHaveBeenCalledWith(5000);
    expect(cancel).toHaveBeenCalledOnce();
  });
  it("bounds a non-success body cancellation that never resolves", async () => {
    vi.useFakeTimers();
    const cancel = vi.fn(() => new Promise<void>(() => {}));
    mocks.fetch.mockResolvedValue(new Response(new ReadableStream({ cancel }), { status: 503 }));
    const work = readRuntimeArtifact(path);
    let result = "pending";
    void work.then(
      () => {
        result = "success";
      },
      () => {
        result = "rejected";
      },
    );
    await vi.advanceTimersByTimeAsync(110);
    expect(result).toBe("rejected");
    expect(cancel).toHaveBeenCalledOnce();
  });
});
