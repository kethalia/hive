import { describe, expect, it } from "vitest";
import { githubSourceDigest } from "@/lib/delivery/github-evidence.server";
import {
  type ReleaseActionIdentity,
  type ReleaseActionJournal,
  transitionReleaseAction,
} from "@/lib/delivery/release-action-journal";
import {
  type ReleaseEffectJournal,
  type ReleaseEffectProvider,
  ReleaseEffectRunner,
} from "@/lib/delivery/release-effect-runner.server";

const identity: ReleaseActionIdentity = {
  id: "00000000-0000-4000-8000-000000000001",
  releaseId: "00000000-0000-4000-8000-000000000002",
  kind: "merge",
  targetDigest: "a".repeat(64),
  request: {},
  requestDigest: githubSourceDigest({}),
  generation: 1,
};
const evidence = { providerOperation: "fixture" };
const receipt = {
  requestDigest: identity.requestDigest,
  receiptDigest: githubSourceDigest(evidence),
  evidence,
};
function fixture(provider: ReleaseEffectProvider) {
  let state: ReleaseActionJournal = { identity, phase: "prepared", receiptDigest: null };
  let validFence = true;
  let reference: Record<string, unknown> | null = null;
  const journal: ReleaseEffectJournal = {
    async begin() {
      if (state.phase !== "prepared" || !validFence) return null;
      state = transitionReleaseAction(state, { type: "dispatch" });
      return identity;
    },
    async reconciliation() {
      return ["effect_started", "held"].includes(state.phase) ? { identity, reference } : null;
    },
    async hold(_identity, remoteReference) {
      if (remoteReference) reference = remoteReference;
      if (state.phase === "effect_started")
        state = transitionReleaseAction(state, { type: "unknown" });
    },
    async record(_identity, value) {
      if (!validFence) return false;
      state = transitionReleaseAction(state, {
        type: "observed",
        requestDigest: value.requestDigest,
        receiptDigest: value.receiptDigest,
      });
      return true;
    },
  };
  return {
    runner: new ReleaseEffectRunner(journal, provider),
    state: () => state,
    revoke: () => {
      validFence = false;
    },
  };
}

describe("release effect runner", () => {
  it("holds a lost acknowledgement and reconciles by read without a second mutation", async () => {
    let sends = 0,
      reads = 0;
    const f = fixture({
      async dispatch() {
        sends++;
        throw new Error("lost ack");
      },
      async lookup() {
        reads++;
        return receipt;
      },
    });
    const signal = new AbortController().signal;
    expect(await f.runner.dispatch(identity.id, signal)).toBe("held");
    expect(await f.runner.dispatch(identity.id, signal)).toBe("not_started");
    expect(await f.runner.reconcile(identity.id, signal)).toBe("observed");
    expect([sends, reads, f.state().phase]).toEqual([1, 1, "observed"]);
  });
  it("holds ambiguous or foreign receipts and never advances a revoked fence", async () => {
    let lookup: unknown = null;
    const f = fixture({
      async dispatch() {
        return { ...receipt, requestDigest: "d".repeat(64) };
      },
      async lookup() {
        return lookup;
      },
    });
    const signal = new AbortController().signal;
    expect(await f.runner.dispatch(identity.id, signal)).toBe("held");
    expect(await f.runner.reconcile(identity.id, signal)).toBe("held");
    lookup = receipt;
    f.revoke();
    expect(await f.runner.reconcile(identity.id, signal)).toBe("held");
    expect(f.state().phase).toBe("held");
  });
  it("admits one concurrent sender and holds a late response after abort", async () => {
    let sends = 0;
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    const f = fixture({
      async dispatch() {
        sends++;
        await waiting;
        return receipt;
      },
      async lookup() {
        return null;
      },
    });
    const controller = new AbortController();
    const first = f.runner.dispatch(identity.id, controller.signal);
    expect(await f.runner.dispatch(identity.id, controller.signal)).toBe("not_started");
    controller.abort();
    release();
    expect(await first).toBe("held");
    expect([sends, f.state().phase]).toEqual([1, "held"]);
  });
});
