import { afterEach, describe, expect, it, vi } from "vitest";
import { boundedCoderJson } from "./bounded-coder-json";
import { createManagedCoderKey } from "./managed-keys";
import { awaitRotationProvider, runCredentialRotation } from "./rotation-scheduler";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("rotation scheduling transport bounds", () => {
  it("defaults off before credential configuration or database access", async () => {
    vi.stubEnv("HIVE_TOKEN_ROTATION_ENABLED", "false");
    vi.stubEnv("ENCRYPTION_KEY", "");
    expect(await runCredentialRotation()).toEqual({ enabled: false });
  });
  it("rejects malformed encryption configuration before claiming or calling Coder", async () => {
    vi.stubEnv("ENCRYPTION_KEY", "invalid");
    await expect(runCredentialRotation({ enabled: true })).rejects.toThrow("configuration_invalid");
  });
  it("a provider that ignores cancellation cannot keep the controller awaiting forever", async () => {
    const abort = new AbortController();
    const pending = awaitRotationProvider(new Promise(() => {}), abort.signal);
    abort.abort();
    await expect(pending).rejects.toThrow("rotation_provider_deadline");
  });
  it("bounds stalled body reads and stalled cancellation independently of Fetch", async () => {
    const abort = new AbortController();
    let cancellation = 0;
    const body = new ReadableStream({
      pull: () => new Promise(() => {}),
      cancel: () => {
        cancellation++;
        return new Promise(() => {});
      },
    });
    const pending = boundedCoderJson(new Response(body), abort.signal);
    abort.abort();
    await expect(pending).rejects.toThrow("coder_response_deadline");
    expect(cancellation).toBe(1);
  });
  it("excess body bytes and empty-chunk flooding fail before metadata establishes key ownership", async () => {
    vi.stubEnv("CODER_CA_CERT", "");
    for (const body of [
      new ReadableStream({
        start(c) {
          c.enqueue(new Uint8Array(16_385));
          c.close();
        },
      }),
      new ReadableStream({
        pull(c) {
          c.enqueue(new Uint8Array());
        },
      }),
    ]) {
      const network = vi.fn().mockResolvedValue(new Response(body));
      vi.stubGlobal("fetch", network);
      expect(
        await createManagedCoderKey("https://coder.example", "private-fixture", "user"),
      ).toBeNull();
      expect(network).toHaveBeenCalledTimes(1);
    }
  });
});
