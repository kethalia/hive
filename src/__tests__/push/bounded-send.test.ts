import type { PrismaClient } from "@hive/db";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => ({ send: vi.fn(), keys: vi.fn() }));
vi.mock("@/lib/push/fetch-transport", () => ({ sendFetchPush: mocked.send }));
vi.mock("@/lib/push/vapid", () => ({ getVapidKeys: mocked.keys }));

import { withAgentWakeEnvironment } from "@/lib/push/agent-event-wake.server";
import type { AgentWakeReceipt } from "@/lib/push/agent-event-wake-contracts";
import { dispatchAgentEvents } from "@/lib/push/agent-events";
import { sendBoundedPush } from "@/lib/push/bounded-send";

const owner = "11111111-1111-4111-8111-111111111111";
const payload = {
  kind: "approval" as const,
  title: "Approval needed",
  body: "Codex is waiting",
  tag: "stable",
  url: "/workspaces?workspace=fixture",
};
function fixture(preferences: Record<string, boolean>[]) {
  const rows = preferences.map((value, i) => ({
    id: String(i),
    endpoint: `https://push.fixture.invalid/${i}`,
    preferences: value,
    p256dh: "synthetic",
    auth: "synthetic",
  }));
  const findMany = vi.fn(async () => rows),
    deleteMany = vi.fn(async () => ({ count: 1 }));
  return {
    db: { pushSubscription: { findMany, deleteMany } } as unknown as PrismaClient,
    findMany,
    deleteMany,
  };
}
beforeEach(() => {
  vi.clearAllMocks();
  mocked.send.mockResolvedValue(undefined);
  mocked.keys.mockResolvedValue({ publicKey: "synthetic", privateKey: "synthetic" });
});
describe("shared bounded agent push transport", () => {
  it("honors the actual event preference independently of template/delivery preferences", async () => {
    const f = fixture([
      { approval: false, template: true },
      { approval: true, template: false },
      {},
    ]);
    expect(await sendBoundedPush(f.db, owner, payload, "mailto:fixture@example.invalid")).toBe(
      "delivered",
    );
    expect(mocked.send).toHaveBeenCalledTimes(2);
    expect(mocked.send.mock.calls[0][2].urgency).toBe("high");
    expect(mocked.send.mock.calls[0][1]).toBe(JSON.stringify(payload));
  });
  it("does not require keys when all event preferences are disabled", async () => {
    expect(await sendBoundedPush(fixture([{ approval: false }]).db, owner, payload, "")).toBe(
      "delivered",
    );
    expect(mocked.keys).not.toHaveBeenCalled();
    expect(mocked.send).not.toHaveBeenCalled();
  });
  it("fails above twenty subscriptions and cleans only the exact owner's expired endpoint", async () => {
    expect(
      await sendBoundedPush(fixture(Array.from({ length: 21 }, () => ({}))).db, owner, payload, ""),
    ).toBe("failed");
    expect(mocked.send).not.toHaveBeenCalled();
    const f = fixture([{}]);
    mocked.send.mockRejectedValueOnce({ statusCode: 410 });
    expect(await sendBoundedPush(f.db, owner, payload, "mailto:fixture@example.invalid")).toBe(
      "delivered",
    );
    expect(f.deleteMany).toHaveBeenCalledWith({
      where: { id: "0", userId: owner, endpoint: "https://push.fixture.invalid/0" },
    });
  });
  it("ordinary dispatch clips delayed subscription work to the enrolled absolute deadline", async () => {
    vi.useFakeTimers();
    vi.stubEnv("CODER_URL", "https://coder.deadline.invalid");
    try {
      const identity = {
        ownerId: owner,
        sourceId: "22222222-2222-4222-8222-222222222222",
        eventKey: "deadline-event",
      };
      const deadline = Date.now() + 30;
      const receipt: AgentWakeReceipt = {
        schemaVersion: 1,
        ...identity,
        createdAt: deadline - 1800000,
        deadline,
        requests: 1,
        attempts: 0,
        phase: "active",
        nextWake: deadline,
        inFlightUntil: 0,
      };
      const claim = {
        id: "33333333-3333-4333-8333-333333333333",
        ownerId: owner,
        eventId: "44444444-4444-4444-8444-444444444444",
        attempt: 1,
      };
      const f = fixture([{}]);
      f.findMany.mockImplementationOnce(async () => {
        await new Promise((resolve) => setTimeout(resolve, 70));
        return [
          {
            id: "subscription",
            endpoint: "https://push.fixture.invalid/1",
            preferences: {},
            p256dh: "synthetic",
            auth: "synthetic",
          },
        ];
      });
      const transaction = {
        $executeRawUnsafe: vi.fn(async () => 1),
        $queryRawUnsafe: vi.fn(async (sql: string) =>
          sql.includes("WITH candidates")
            ? [claim]
            : [{ leaseUntil: new Date(Date.now() + 120000), now: new Date() }],
        ),
        $queryRaw: vi.fn(async () => [{ now: new Date() }]),
      };
      const db = {
        ...f.db,
        $executeRaw: vi.fn(async () => 0),
        $queryRaw: vi.fn(async (sql: TemplateStringsArray) =>
          sql.join("").includes("SELECT owner_id")
            ? [{ ownerId: owner }]
            : [{ payload, sourceId: identity.sourceId, eventKey: identity.eventKey }],
        ),
        $transaction: async (operation: (tx: unknown) => Promise<unknown>) =>
          operation(transaction),
      } as unknown as PrismaClient;
      let admittedSignal: AbortSignal | undefined;
      const dispatch = withAgentWakeEnvironment(
        {
          HIVE_NATIVE_MODE: "preview",
          HIVE_NATIVE_PREVIEW_ENABLED: "true",
          HIVE_AGENT_NOTIFICATION_WAKE_ENABLED: "true",
          HIVE_AGENT_NOTIFICATION_WAKE_EVENT_JSON: JSON.stringify(identity),
          HIVE_AGENT_NOTIFICATION_WAKE: {
            getByName: () => ({ reserve: async () => receipt, inspect: async () => receipt }),
          },
        },
        () =>
          dispatchAgentEvents(
            db,
            (ownerId, value, signal, absoluteDeadline) => {
              admittedSignal = signal;
              expect(absoluteDeadline).toBe(deadline);
              return sendBoundedPush(
                db,
                ownerId,
                value,
                "mailto:fixture@example.invalid",
                signal,
                absoluteDeadline,
              );
            },
            { enabled: true },
          ),
      );
      await vi.advanceTimersByTimeAsync(0);
      expect(f.findMany).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(31);
      expect(admittedSignal?.aborted).toBe(true);
      expect(mocked.send).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(40);
      expect((await dispatch).retry).toBe(1);
      expect(mocked.keys).not.toHaveBeenCalled();
      expect(mocked.send).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
      vi.unstubAllEnvs();
    }
  });
  it("rechecks the absolute deadline at fetch admission when signing delays timer delivery", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const fetch = vi.fn(async () => new Response(null, { status: 201 }));
    vi.stubGlobal("fetch", fetch);
    try {
      const deadline = Date.now() + 30;
      mocked.send.mockImplementationOnce(
        async (_subscription, _payload, _options, transport: typeof globalThis.fetch) => {
          vi.setSystemTime(deadline + 1);
          return transport("https://push.fixture.invalid/late", {});
        },
      );
      expect(
        await sendBoundedPush(
          fixture([{}]).db,
          owner,
          payload,
          "mailto:fixture@example.invalid",
          new AbortController().signal,
          deadline,
        ),
      ).toBe("retry");
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });
});
