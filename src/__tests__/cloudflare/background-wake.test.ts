import { afterEach, describe, expect, it, vi } from "vitest";

const dispatch = vi.hoisted(() => vi.fn());
vi.mock("cloudflare:workers", () => ({
  DurableObject: class {
    constructor(
      public ctx: unknown,
      public env: unknown,
    ) {}
  },
}));
vi.mock("../../../deploy/cloudflare/native/background", () => ({ dispatchBackground: dispatch }));

import { HiveBackground } from "../../../deploy/cloudflare/native/background-wake.mjs";

interface FixtureStorage {
  get(key: string): Promise<unknown>;
  put(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
  getAlarm(): Promise<number | null>;
  setAlarm(value: number): Promise<void>;
  deleteAlarm(): Promise<void>;
  transaction<T>(run: (value: FixtureStorage) => Promise<T>): Promise<T>;
}
function fixture() {
  const values = new Map<string, unknown>();
  let alarm: number | null = null;
  const storage: FixtureStorage = {
    async get(key: string) {
      return values.get(key);
    },
    async put(key: string, value: unknown) {
      values.set(key, value);
    },
    async delete(key: string) {
      values.delete(key);
    },
    async getAlarm() {
      return alarm;
    },
    async setAlarm(value: number) {
      alarm = value;
    },
    async deleteAlarm() {
      alarm = null;
    },
    async transaction<T>(run: (value: FixtureStorage) => Promise<T>) {
      return run(storage);
    },
  };
  const actor = Reflect.construct(HiveBackground, [{ storage }, {}]) as HiveBackground;
  return { actor, values, alarm: () => alarm };
}
const owner = "10000000-0000-4000-8000-000000000001";
afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});
describe("durable per-user background wake", () => {
  it("coalesces wakes and retains the earliest time", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1000000);
    const f = fixture();
    await f.actor.wake(owner, 1005000);
    await f.actor.wake(owner, 1010000);
    expect(f.alarm()).toBe(1005000);
    await f.actor.wake(owner, 1002000);
    expect(f.alarm()).toBe(1002000);
    await expect(f.actor.wake("20000000-0000-4000-8000-000000000001")).rejects.toThrow(
      "owner mismatch",
    );
  });
  it("clears idle alarms after draining work", async () => {
    const f = fixture();
    await f.actor.wake(owner);
    dispatch.mockResolvedValueOnce(null);
    await f.actor.alarm();
    expect(f.alarm()).toBeNull();
    expect(f.values.has("pending")).toBe(false);
    expect(dispatch).toHaveBeenCalledWith({}, owner);
  });
  it("preserves a new wake arriving while dispatch waits for a provider", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1000000);
    const f = fixture();
    await f.actor.wake(owner);
    let finish!: (at: number | null) => void;
    dispatch.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const running = f.actor.alarm();
    await vi.waitFor(() => expect(dispatch).toHaveBeenCalled());
    await f.actor.wake(owner, 1002000);
    finish(1010000);
    await running;
    expect(f.alarm()).toBe(1002000);
  });
  it("retains a fallback alarm on dispatch failure and recovers with the same owner", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1000000);
    const f = fixture();
    await f.actor.wake(owner);
    dispatch.mockRejectedValueOnce(new Error("database temporarily unavailable"));
    await expect(f.actor.alarm()).rejects.toThrow("temporarily");
    expect(f.alarm()).toBe(1120000);
    dispatch.mockResolvedValueOnce(1200000);
    await f.actor.alarm();
    expect(f.alarm()).toBe(1200000);
  });
  it("rejects malformed owners and unbounded future wakes", async () => {
    const f = fixture();
    await expect(f.actor.wake("unknown")).rejects.toThrow("Invalid");
    await expect(f.actor.wake(owner, Date.now() + 2 * 86400000)).rejects.toThrow("Invalid");
    expect(f.values.size).toBe(0);
  });
});
