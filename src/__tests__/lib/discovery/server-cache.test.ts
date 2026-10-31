import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cachedDiscovery,
  discoveryCacheKey,
  invalidateDiscovery,
} from "@/lib/discovery/server-cache";

const redis = vi.hoisted(() => {
  const values = new Map<string, string>();
  return {
    values,
    options: vi.fn(),
    connect: vi.fn(),
    disconnect: vi.fn(),
    on: vi.fn(),
    get: vi.fn(async (key: string) => values.get(key) ?? null),
    set: vi.fn(async (key: string, value: string) => {
      values.set(key, value);
    }),
    incr: vi.fn(async (key: string) => {
      const next = Number(values.get(key) ?? 0) + 1;
      values.set(key, String(next));
      return next;
    }),
    eval: vi.fn(async (_script: string, _count: number, key: string) => {
      const next = Number(values.get(key) ?? 0) + 1;
      values.set(key, String(next));
      return next;
    }),
    pexpire: vi.fn(async () => 1),
    pttl: vi.fn(async () => 500),
  };
});
vi.mock("ioredis", () => ({
  default: class {
    status = "ready";
    constructor(_url: string, options: unknown) {
      redis.options(options);
    }
    connect = redis.connect;
    disconnect = redis.disconnect;
    on = redis.on;
    eval = redis.eval;
    get = redis.get;
    set = redis.set;
    incr = redis.incr;
    pexpire = redis.pexpire;
    pttl = redis.pttl;
  },
}));
let sequence = 0;
let key: string;
beforeEach(() => {
  key = discoveryCacheKey([String(++sequence)]);
  vi.stubEnv("REDIS_URL", "");
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe("bounded discovery cache", () => {
  it("never shares pending request IO or connects Redis in Workers", async () => {
    vi.stubEnv("HIVE_RUNTIME_TARGET", "cloudflare");
    vi.stubEnv("REDIS_URL", "redis://should-not-connect.invalid");
    redis.connect.mockClear();
    redis.get.mockClear();
    redis.eval.mockClear();
    const first = deferred<string>();
    const second = deferred<string>();
    const load = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const one = cachedDiscovery({ key, ttl: 1000, load });
    const two = cachedDiscovery({ key, ttl: 1000, load });
    expect(load).toHaveBeenCalledTimes(2);
    second.resolve("second-request");
    expect(await two).toBe("second-request");
    first.resolve("first-request");
    expect(await one).toBe("first-request");
    await invalidateDiscovery(key);
    expect(await cachedDiscovery({ key, ttl: 1000, load: async () => "fresh" })).toBe("fresh");
    expect(redis.connect).not.toHaveBeenCalled();
    expect(redis.get).not.toHaveBeenCalled();
    expect(redis.eval).not.toHaveBeenCalled();
  });
  it("deduplicates concurrent reads, caches empty successes and expires them", async () => {
    vi.useFakeTimers();
    const result = deferred<string[]>();
    const load = vi.fn(() => result.promise);
    const first = cachedDiscovery({ key, ttl: 100, load });
    const second = cachedDiscovery({ key, ttl: 100, load });
    await Promise.resolve();
    expect(load).toHaveBeenCalledTimes(1);
    result.resolve([]);
    expect(await first).toEqual([]);
    expect(await second).toEqual([]);
    await cachedDiscovery({ key, ttl: 100, load });
    expect(load).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(101);
    await cachedDiscovery({ key, ttl: 100, load });
    expect(load).toHaveBeenCalledTimes(2);
  });
  it("does not let an old in-flight result overwrite a forced refresh or mutation", async () => {
    const old = deferred<string>();
    const first = cachedDiscovery({ key, ttl: 1000, load: () => old.promise });
    await Promise.resolve();
    await cachedDiscovery({ key, ttl: 1000, refresh: true, load: async () => "new" });
    old.resolve("old");
    await first;
    expect(await cachedDiscovery({ key, ttl: 1000, load: async () => "wrong" })).toBe("new");
    await invalidateDiscovery(key);
    expect(await cachedDiscovery({ key, ttl: 1000, load: async () => "after mutation" })).toBe(
      "after mutation",
    );
  });
  it("never caches failures, rejected snapshots or oversized values", async () => {
    const load = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValue("ok");
    await expect(cachedDiscovery({ key, ttl: 1000, load })).rejects.toThrow("offline");
    expect(await cachedDiscovery({ key, ttl: 1000, load })).toBe("ok");
    await invalidateDiscovery(key);
    const huge = vi.fn(async () => "x".repeat(1024 * 1024));
    await cachedDiscovery({ key, ttl: 1000, load: huge });
    await cachedDiscovery({ key, ttl: 1000, load: huge });
    expect(huge).toHaveBeenCalledTimes(2);
    const skipped = vi.fn(async () => []);
    await cachedDiscovery({ key, ttl: 1000, load: skipped, cacheable: () => false });
    await cachedDiscovery({ key, ttl: 1000, load: skipped });
    expect(skipped).toHaveBeenCalledTimes(2);
  });
  it("isolates users, origins and builds without putting identifiers in Redis keys", () => {
    const scope = ["repos", "https://coder.example", "alice", "dev", "build-1"];
    const first = discoveryCacheKey(scope);
    for (let index = 1; index < scope.length; index++) {
      const changed = [...scope];
      changed[index] = "other";
      expect(discoveryCacheKey(changed)).not.toBe(first);
    }
    expect(first).not.toContain("alice");
    expect(first).not.toContain("coder.example");
  });
  it("uses finite interactive Redis settings and generation keys; falls back on outages", async () => {
    vi.stubEnv("REDIS_URL", "redis://test");
    redis.connect.mockResolvedValue(undefined);
    const load = vi.fn(async () => "first");
    await cachedDiscovery({ key, ttl: 1000, load });
    expect(redis.options).toHaveBeenCalledWith(
      expect.objectContaining({
        enableOfflineQueue: false,
        maxRetriesPerRequest: 0,
        commandTimeout: 200,
        connectTimeout: 200,
      }),
    );
    expect(redis.set).toHaveBeenCalledWith(`${key}:0`, '"first"', "PX", 1000);
    await invalidateDiscovery(key);
    await cachedDiscovery({ key, ttl: 1000, load: async () => "second" });
    expect(redis.set).toHaveBeenCalledWith(`${key}:1`, '"second"', "PX", 1000);
    redis.get.mockRejectedValueOnce(new Error("offline"));
    expect(await cachedDiscovery({ key, ttl: 1000, load: async () => "fallback" })).toBe(
      "fallback",
    );
  });
});

it("reads a shared cached value without a new scan", async () => {
  vi.stubEnv("REDIS_URL", "redis://test");
  redis.values.set(`${key}:0`, JSON.stringify(["shared"]));
  const load = vi.fn(async () => ["fresh"]);
  expect(await cachedDiscovery({ key, ttl: 1000, load })).toEqual(["shared"]);
  expect(load).not.toHaveBeenCalled();
});
