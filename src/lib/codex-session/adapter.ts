import {
  pageSchema,
  parseSessionEvent,
  resumeSchema,
  type SessionEvent,
  type SessionTurn,
} from "./protocol";

export type SessionBinding = {
  ownerId: string;
  workspaceId: string;
  buildId: string;
  serverInstanceId: string;
  threadId: string;
};

/** Must be issued by a host transport after server-side owner/workspace authorization.
 * A matching object is not authentication. Never expose arbitrary endpoint URLs or
 * bearer credentials to callers. Each request must time out, and onClose must fire
 * on auth revocation, overflow, or connection loss. Notifications are ordered and
 * delivered once within this connection; no native delta replay cursor exists.
 */
export interface AuthorizedSessionTransport {
  binding: SessionBinding;
  request(
    method: "initialize" | "thread/resume" | "thread/turns/list",
    params: unknown,
  ): Promise<unknown>;
  notify(method: "initialized"): void;
  onNotification(listener: (event: unknown) => void): () => void;
  onClose(listener: (reason?: "revoked" | "disconnected") => void): () => void;
  close(): void;
}

export type SessionView = {
  phase: "disconnected" | "loading" | "live" | "awaiting-first-turn" | "unavailable" | "error";
  turns: SessionTurn[];
  needsRefresh: boolean;
  error: string | null;
};

const MAX_BUFFERED_EVENTS = 2000;
const MAX_HISTORY_PAGES = 20;

/** Read/subscription adapter: this class cannot create threads or start inference.
 * The creation workflow owns the first real turn and its durable thread binding.
 */
export class CodexSessionAdapter {
  private readonly binding: SessionBinding;
  private transport?: AuthorizedSessionTransport;
  private unlisten: (() => void)[] = [];
  private generation = 0;
  private buffer: SessionEvent[] | null = null;
  private invalidation = 0;
  private invalidationRetries = 0;
  private reconciliationScheduled = false;
  private hydration?: Promise<void>;
  private view: SessionView = {
    phase: "disconnected",
    turns: [],
    needsRefresh: false,
    error: null,
  };

  constructor(
    binding: SessionBinding,
    private readonly changed: (view: SessionView) => void,
    // Set only from the trusted result of this project's explicit thread creation.
    private awaitingFirstTurn = false,
  ) {
    this.binding = { ...binding };
  }

  get snapshot(): SessionView {
    return structuredClone(this.view);
  }

  private publish() {
    this.changed(this.snapshot);
  }

  disconnect(reason: "revoked" | "disconnected" = "disconnected") {
    this.generation++;
    for (const stop of this.unlisten.splice(0)) stop();
    this.transport?.close();
    this.transport = undefined;
    this.buffer = null;
    this.hydration = undefined;
    this.invalidationRetries = 0;
    this.reconciliationScheduled = false;
    this.view = {
      ...this.view,
      phase: "disconnected",
      needsRefresh: true,
      turns: reason === "revoked" ? [] : this.view.turns,
    };
    this.publish();
  }

  async connect(transport: AuthorizedSessionTransport): Promise<void> {
    this.disconnect();
    if (
      Object.keys(this.binding).some(
        (key) =>
          this.binding[key as keyof SessionBinding] !==
          transport.binding[key as keyof SessionBinding],
      )
    ) {
      transport.close();
      throw new Error("The authenticated host session binding changed.");
    }
    const generation = this.generation;
    this.transport = transport;
    this.view = { ...this.view, phase: "loading", error: null, needsRefresh: true };
    this.buffer = [];
    this.unlisten = [
      transport.onNotification((raw) => {
        if (generation !== this.generation) return;
        try {
          const event = parseSessionEvent(raw, this.binding.threadId);
          if (!event) return;
          if (event.kind === "invalidate") {
            this.invalidation++;
            this.view.turns = [];
            this.view.needsRefresh = true;
            this.view.phase = "loading";
            // Anything buffered before the truncation refers to the old history.
            this.buffer = [];
            this.scheduleRefresh();
          }
          if (this.buffer) {
            if (this.buffer.length >= MAX_BUFFERED_EVENTS)
              throw new Error("Session event buffer exceeded its limit.");
            this.buffer.push(event);
          } else this.apply(event, false);
          this.publish();
        } catch {
          this.fail("Session events are invalid or exceeded the supported limit.");
        }
      }),
      transport.onClose((reason) => {
        if (generation === this.generation) this.disconnect(reason);
      }),
    ];
    this.publish();
    try {
      await transport.request("initialize", {
        clientInfo: { name: "hive_session", version: "0.1.0" },
      });
      if (generation !== this.generation) return;
      transport.notify("initialized");
      const result = resumeSchema.parse(
        await transport.request("thread/resume", {
          threadId: this.binding.threadId,
          excludeTurns: true,
        }),
      );
      if (generation !== this.generation) return;
      if (result.thread.id !== this.binding.threadId)
        throw new Error("Unexpected native thread identity.");
      this.awaitingFirstTurn = false;
      await this.refresh();
    } catch (error) {
      if (generation !== this.generation) return;
      const missing = isMissingRollout(error);
      this.fail(
        missing
          ? "Native thread history is not available."
          : "Could not attach to the native session.",
        missing ? (this.awaitingFirstTurn ? "awaiting-first-turn" : "unavailable") : "error",
      );
    }
  }

  async refresh(): Promise<void> {
    if (this.hydration) return this.hydration;
    const transport = this.transport;
    if (!transport) return;
    const generation = this.generation;
    const hydration = this.hydrate(transport, generation);
    this.hydration = hydration;
    try {
      await hydration;
    } catch {
      if (generation === this.generation) this.fail("Native history could not be reconciled.");
    } finally {
      if (this.hydration === hydration) this.hydration = undefined;
    }
  }

  private scheduleRefresh() {
    if (this.reconciliationScheduled) return;
    this.reconciliationScheduled = true;
    const generation = this.generation;
    queueMicrotask(async () => {
      // Let an in-flight page notice the changed history epoch before reading again.
      await this.hydration?.catch(() => {});
      if (generation !== this.generation) return;
      this.reconciliationScheduled = false;
      if (this.transport && this.view.needsRefresh) await this.refresh();
    });
  }

  private async hydrate(transport: AuthorizedSessionTransport, generation: number) {
    const invalidation = this.invalidation;
    this.buffer ??= [];
    this.view.phase = "loading";
    this.publish();
    const turns = new Map<string, SessionTurn>();
    const cursors = new Set<string>();
    let cursor: string | undefined;
    for (let pageIndex = 0; ; pageIndex++) {
      if (pageIndex >= MAX_HISTORY_PAGES) throw new Error("History pagination exceeded its limit.");
      const page = pageSchema.parse(
        await transport.request("thread/turns/list", {
          threadId: this.binding.threadId,
          itemsView: "full",
          sortDirection: "asc",
          limit: 100,
          ...(cursor ? { cursor } : {}),
        }),
      );
      if (generation !== this.generation) return;
      if (invalidation !== this.invalidation) {
        if (++this.invalidationRetries > 3)
          throw new Error("History changed too often to reconcile.");
        return;
      }
      for (const turn of page.data) {
        if (turn.itemsView !== "full") throw new Error("Native server returned partial history.");
        turns.set(turn.id, turn);
      }
      if (page.nextCursor === null) break;
      if (cursors.has(page.nextCursor)) throw new Error("Native server repeated a history cursor.");
      cursors.add(page.nextCursor);
      cursor = page.nextCursor;
    }
    this.view = { phase: "live", turns: [...turns.values()], needsRefresh: false, error: null };
    this.invalidationRetries = 0;
    const buffered = this.buffer ?? [];
    this.buffer = null;
    // Invalidations before hydration are covered by this snapshot. Invalidations
    // during hydration already rejected it through the epoch check above.
    for (const event of buffered) if (event.kind !== "invalidate") this.apply(event, true);
    this.publish();
  }

  private apply(event: SessionEvent, buffered: boolean) {
    if (event.kind === "invalidate") {
      this.view.needsRefresh = true;
      return;
    }
    const turnId = event.kind === "turn" ? event.turn.id : event.turnId;
    let turn = this.view.turns.find((value) => value.id === turnId);
    if (event.kind === "turn") {
      if (!turn) this.view.turns.push(event.turn);
      else if (event.complete) {
        Object.assign(turn, event.turn, {
          items: event.turn.itemsView === "full" ? event.turn.items : turn.items,
        });
        if (event.turn.itemsView !== "full") this.view.needsRefresh = true;
      }
      return;
    }
    if (!turn) {
      turn = { id: turnId, items: [], itemsView: "notLoaded", status: "inProgress" };
      this.view.turns.push(turn);
      this.view.needsRefresh = true;
    }
    if (event.kind === "item") {
      const index = turn.items.findIndex((item) => item.id === event.item.id);
      if (index === -1) turn.items.push(event.item);
      else if (event.complete) turn.items[index] = event.item;
    } else {
      // A buffered delta may already be included in the snapshot. Native events
      // have no sequence ID: don't concatenate ambiguous text and pretend it is exact.
      if (buffered) {
        this.view.needsRefresh = true;
        return;
      }
      const item = turn.items.find((item) => item.id === event.itemId);
      if (!item || turn.status !== "inProgress") {
        this.view.needsRefresh = true;
        return;
      }
      if (
        (event.field === "text" && item.type !== "agentMessage") ||
        (event.field === "aggregatedOutput" && item.type !== "commandExecution")
      ) {
        this.view.needsRefresh = true;
        return;
      }
      const current = item[event.field] ?? "";
      if (current.length + event.delta.length > 1_000_000) {
        this.view.needsRefresh = true;
        return;
      }
      item[event.field] = current + event.delta;
    }
  }

  private fail(error: string, phase: SessionView["phase"] = "error") {
    this.disconnect("revoked");
    this.view = { ...this.view, phase, error, needsRefresh: true };
    this.publish();
  }
}

function isMissingRollout(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as { code?: unknown; message?: unknown };
  return (
    candidate.code === -32600 &&
    typeof candidate.message === "string" &&
    candidate.message.includes("no rollout found for thread id")
  );
}
