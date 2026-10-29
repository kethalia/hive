import { describe, expect, it, vi } from "vitest";
import {
  type AuthorizedSessionTransport,
  CodexSessionAdapter,
  type SessionBinding,
} from "@/lib/codex-session/adapter";

const binding: SessionBinding = {
  ownerId: "owner",
  workspaceId: "workspace",
  buildId: "build",
  serverInstanceId: "server",
  threadId: "thread",
};
const message = (text = "hello") => ({ type: "agentMessage", id: "message", text });
const turn = (text = "hello", status = "completed") => ({
  id: "turn",
  status,
  itemsView: "full",
  items: [message(text)],
});
const page = (data: unknown[] = [turn()], nextCursor: string | null = null) => ({
  data,
  nextCursor,
});

class FakeTransport implements AuthorizedSessionTransport {
  binding = { ...binding };
  listeners = new Set<(event: unknown) => void>();
  closers = new Set<(reason?: "revoked" | "disconnected") => void>();
  read: (params: unknown) => Promise<unknown> = async () => page();
  resume: () => Promise<unknown> = async () => ({ thread: { id: binding.threadId } });
  request = vi.fn(async (method: string, params: unknown) => {
    if (method === "initialize") return {};
    if (method === "thread/resume") return this.resume();
    if (method === "thread/turns/list") return this.read(params);
    throw new Error(`Unexpected mutation: ${method}`);
  });
  notify = vi.fn();
  close = vi.fn();
  onNotification(listener: (event: unknown) => void) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  onClose(listener: (reason?: "revoked" | "disconnected") => void) {
    this.closers.add(listener);
    return () => {
      this.closers.delete(listener);
    };
  }
  emit(method: string, params: object) {
    for (const listener of this.listeners)
      listener({ method, params: { threadId: binding.threadId, ...params } });
  }
  drop(reason?: "revoked" | "disconnected") {
    for (const listener of [...this.closers]) listener(reason);
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("native Codex session adapter", () => {
  it("subscribes before resume and deduplicates canonical history and completion by ID", async () => {
    const transport = new FakeTransport();
    transport.resume = async () => {
      expect(transport.listeners.size).toBe(1);
      transport.emit("turn/completed", { turn: turn() });
      return { thread: { id: binding.threadId } };
    };
    const adapter = new CodexSessionAdapter(binding, vi.fn());
    await adapter.connect(transport);
    transport.emit("item/completed", { turnId: "turn", item: message() });
    transport.emit("item/completed", { turnId: "turn", item: message() });
    expect(adapter.snapshot).toMatchObject({
      phase: "live",
      turns: [{ id: "turn", items: [message()] }],
    });
    expect(adapter.snapshot.turns).toHaveLength(1);
    expect(adapter.snapshot.turns[0].items).toHaveLength(1);
    expect(transport.request.mock.calls.map(([method]) => method)).toEqual([
      "initialize",
      "thread/resume",
      "thread/turns/list",
    ]);
  });

  it("does not append buffered deltas already covered by the history snapshot", async () => {
    const transport = new FakeTransport();
    transport.read = async () => {
      transport.emit("item/agentMessage/delta", {
        turnId: "turn",
        itemId: "message",
        delta: "hello",
      });
      return page([turn("hello", "inProgress")]);
    };
    const adapter = new CodexSessionAdapter(binding, vi.fn());
    await adapter.connect(transport);
    expect(adapter.snapshot.turns[0].items[0].text).toBe("hello");
    expect(adapter.snapshot.needsRefresh).toBe(true);
    transport.emit("item/agentMessage/delta", {
      turnId: "turn",
      itemId: "message",
      delta: " world",
    });
    expect(adapter.snapshot.turns[0].items[0].text).toBe("hello world");
    transport.emit("item/completed", { turnId: "turn", item: message("hello world!") });
    expect(adapter.snapshot.turns[0].items[0].text).toBe("hello world!");
  });

  it("recovers missed messages on reconnect without starting another thread or turn", async () => {
    const first = new FakeTransport();
    const adapter = new CodexSessionAdapter(binding, vi.fn());
    await adapter.connect(first);
    first.drop();
    expect(adapter.snapshot.phase).toBe("disconnected");
    const second = new FakeTransport();
    second.read = async () => page([turn(), { ...turn("offline output"), id: "offline" }]);
    await adapter.connect(second);
    expect(adapter.snapshot.turns.map((t) => t.id)).toEqual(["turn", "offline"]);
    expect(second.request.mock.calls.map(([method]) => method)).toEqual([
      "initialize",
      "thread/resume",
      "thread/turns/list",
    ]);
    expect(first.listeners.size).toBe(0);
  });

  it("ignores late snapshots from a disconnected generation", async () => {
    const first = new FakeTransport();
    const delayed = deferred<unknown>();
    const entered = deferred<void>();
    first.read = async () => {
      entered.resolve();
      return delayed.promise;
    };
    const adapter = new CodexSessionAdapter(binding, vi.fn());
    const connecting = adapter.connect(first);
    await entered.promise;
    const second = new FakeTransport();
    second.read = async () => page([turn("new connection")]);
    await adapter.connect(second);
    delayed.resolve(page([turn("stale connection")]));
    await connecting;
    expect(adapter.snapshot.turns[0].items[0].text).toBe("new connection");
  });

  it("clears visible history on authorization revocation while preserving it on network loss", async () => {
    const adapter = new CodexSessionAdapter(binding, vi.fn());
    const first = new FakeTransport();
    await adapter.connect(first);
    first.drop("disconnected");
    expect(adapter.snapshot.turns).toHaveLength(1);
    const second = new FakeTransport();
    await adapter.connect(second);
    second.drop("revoked");
    expect(adapter.snapshot.turns).toEqual([]);
  });

  it("distinguishes known empty bootstrap from missing persisted history", async () => {
    for (const bootstrap of [false, true]) {
      const transport = new FakeTransport();
      transport.resume = async () => {
        throw { code: -32600, message: "no rollout found for thread id thread" };
      };
      const adapter = new CodexSessionAdapter(binding, vi.fn(), bootstrap);
      await adapter.connect(transport);
      expect(adapter.snapshot.phase).toBe(bootstrap ? "awaiting-first-turn" : "unavailable");
      expect(transport.request.mock.calls.map(([method]) => method)).toEqual([
        "initialize",
        "thread/resume",
      ]);
      expect(transport.close).toHaveBeenCalled();
    }
  });

  it("rejects a different authenticated host binding before reading any session", async () => {
    const adapter = new CodexSessionAdapter(binding, vi.fn());
    const transport = new FakeTransport();
    transport.binding.buildId = "different-build";
    await expect(adapter.connect(transport)).rejects.toThrow("binding changed");
    expect(transport.request).not.toHaveBeenCalled();
  });

  it("does not treat history loss as an empty draft after a successful attachment", async () => {
    const adapter = new CodexSessionAdapter(binding, vi.fn(), true);
    await adapter.connect(new FakeTransport());
    const missing = new FakeTransport();
    missing.resume = async () => {
      throw { code: -32600, message: "no rollout found for thread id thread" };
    };
    await adapter.connect(missing);
    expect(adapter.snapshot.phase).toBe("unavailable");
  });

  it("ignores another thread and replaces reverted history instead of resurrecting it", async () => {
    const transport = new FakeTransport();
    const adapter = new CodexSessionAdapter(binding, vi.fn());
    await adapter.connect(transport);
    transport.emit("turn/completed", {
      threadId: "other",
      turn: { ...turn("private"), id: "other-turn" },
    });
    expect(adapter.snapshot.turns).toHaveLength(1);
    transport.read = async () => page([]);
    transport.emit("thread/reverted", {});
    expect(adapter.snapshot.turns).toEqual([]);
    await vi.waitFor(() => expect(adapter.snapshot.phase).toBe("live"));
    expect(adapter.snapshot.turns).toEqual([]);
    expect(adapter.snapshot.needsRefresh).toBe(false);
  });

  it("automatically rereads an invalidated in-flight snapshot without resurrecting deleted turns", async () => {
    const transport = new FakeTransport();
    let reads = 0;
    transport.read = async () => {
      if (reads++ === 0) {
        transport.emit("thread/reverted", {});
        return page([turn("deleted")]);
      }
      return page([]);
    };
    const adapter = new CodexSessionAdapter(binding, vi.fn());
    await adapter.connect(transport);
    await vi.waitFor(() => expect(adapter.snapshot.phase).toBe("live"));
    expect(adapter.snapshot.turns).toEqual([]);
    expect(reads).toBe(2);
  });

  it("bounds automatic invalidation retries rather than spinning indefinitely", async () => {
    const transport = new FakeTransport();
    let reads = 0;
    transport.read = async () => {
      reads++;
      transport.emit("thread/reverted", {});
      return page([turn("deleted")]);
    };
    const adapter = new CodexSessionAdapter(binding, vi.fn());
    await adapter.connect(transport);
    await vi.waitFor(() => expect(adapter.snapshot.phase).toBe("error"));
    expect(reads).toBe(4);
    expect(adapter.snapshot.turns).toEqual([]);
  });

  it("coalesces invalidation bursts into one automatic history read", async () => {
    const transport = new FakeTransport();
    const adapter = new CodexSessionAdapter(binding, vi.fn());
    await adapter.connect(transport);
    transport.read = async () => page([]);
    transport.emit("thread/reverted", {});
    transport.emit("thread/reverted", {});
    await vi.waitFor(() => expect(adapter.snapshot.phase).toBe("live"));
    expect(
      transport.request.mock.calls.filter(([method]) => method === "thread/turns/list"),
    ).toHaveLength(2);
  });

  it("deduplicates overlapping turn pages and rejects looping cursors", async () => {
    const transport = new FakeTransport();
    let requests = 0;
    transport.read = async () =>
      requests++ === 0
        ? page([turn()], "next")
        : page([turn(), { ...turn("second"), id: "second" }]);
    const adapter = new CodexSessionAdapter(binding, vi.fn());
    await adapter.connect(transport);
    expect(adapter.snapshot.turns.map((t) => t.id)).toEqual(["turn", "second"]);
    transport.read = async () => page([], "loop");
    await adapter.refresh();
    expect(adapter.snapshot.phase).toBe("error");
  });

  it("retains unknown items only as placeholders and strips hidden reasoning", async () => {
    const transport = new FakeTransport();
    transport.read = async () =>
      page([
        {
          ...turn(),
          items: [{ id: "reason", type: "reasoning", content: ["private reasoning"], summary: [] }],
        },
      ]);
    const adapter = new CodexSessionAdapter(binding, vi.fn());
    await adapter.connect(transport);
    expect(adapter.snapshot.turns[0].items).toEqual([
      { id: "reason", type: "reasoning", unsupported: true },
    ]);
    expect(JSON.stringify(adapter.snapshot)).not.toContain("private reasoning");
  });

  it("fails visibly on malformed events rather than accepting corrupt conversation state", async () => {
    const transport = new FakeTransport();
    const adapter = new CodexSessionAdapter(binding, vi.fn());
    await adapter.connect(transport);
    transport.emit("item/completed", { turnId: "turn", item: { id: "missing-type" } });
    expect(adapter.snapshot.phase).toBe("error");
    expect(transport.close).toHaveBeenCalled();
  });
});
