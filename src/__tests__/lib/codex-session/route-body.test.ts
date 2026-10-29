import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@hive/db", () => ({ getDb: vi.fn() }));
vi.mock("@/lib/auth/session", () => ({ getRequestSession: vi.fn() }));
vi.mock("@/lib/codex-session/registered-session.server", () => ({
  createRegisteredSessionService: vi.fn(),
  registeredSessionConfig: vi.fn(),
}));

import { boundedSessionJson } from "@/lib/codex-session/route.server";

afterEach(() => vi.useRealTimers());
function request(body: ReadableStream<Uint8Array>) {
  return new Request("https://preview.example/api/codex-host/registrations", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
    duplex: "half",
  } as RequestInit);
}
describe("bounded native JSON transport", () => {
  it("parses bounded JSON and rejects oversize bytes with cancellation", async () => {
    expect(
      await boundedSessionJson(
        new Request("https://preview.example", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: '{"proof":"fixture"}',
        }),
      ),
    ).toEqual({ proof: "fixture" });
    const cancel = vi.fn();
    const result = boundedSessionJson(
      request(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array(4097));
          },
          cancel,
        }),
      ),
      4096,
    );
    await expect(result).rejects.toThrow("invalid_request");
    expect(cancel).toHaveBeenCalledOnce();
  });
  it("finishes a stalled read after5s even when cancellation also never settles", async () => {
    vi.useFakeTimers();
    const cancel = vi.fn(() => new Promise<void>(() => {}));
    const result = boundedSessionJson(request(new ReadableStream({ cancel })));
    const rejection = expect(result).rejects.toThrow("timeout");
    await vi.advanceTimersByTimeAsync(5100);
    await rejection;
    expect(cancel).toHaveBeenCalledOnce();
  });
  it("rejects an unending empty-chunk stream without starving its timeout", async () => {
    let reads = 0;
    const cancel = vi.fn();
    const stream = new ReadableStream(
      {
        pull(controller) {
          reads++;
          controller.enqueue(new Uint8Array());
        },
        cancel,
      },
      { highWaterMark: 0 },
    );
    await expect(boundedSessionJson(request(stream))).rejects.toThrow("invalid_request");
    expect(reads).toBe(1025);
    expect(cancel).toHaveBeenCalledOnce();
  });
});
