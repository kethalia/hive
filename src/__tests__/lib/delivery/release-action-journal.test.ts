import { describe, expect, it } from "vitest";
import { githubSourceDigest } from "@/lib/delivery/github-evidence.server";
import {
  releaseActionJournalSchema,
  transitionReleaseAction,
} from "@/lib/delivery/release-action-journal";

const identity = {
  id: "00000000-0000-4000-8000-000000000001",
  releaseId: "00000000-0000-4000-8000-000000000002",
  kind: "merge",
  targetDigest: "a".repeat(64),
  request: {},
  requestDigest: githubSourceDigest({}),
  generation: 1,
};
const prepared = () =>
  releaseActionJournalSchema.parse({ identity, phase: "prepared", receiptDigest: null });
const observed = {
  type: "observed",
  requestDigest: identity.requestDigest,
  receiptDigest: "c".repeat(64),
};

describe("release action effect journal", () => {
  it("records dispatch before an attributable observation and accepts only exact receipt replay", () => {
    const started = transitionReleaseAction(prepared(), { type: "dispatch" });
    const done = transitionReleaseAction(started, observed);
    expect(done.phase).toBe("observed");
    expect(transitionReleaseAction(done, observed)).toEqual(done);
    expect(() =>
      transitionReleaseAction(done, { ...observed, receiptDigest: "d".repeat(64) }),
    ).toThrow();
    expect(() => transitionReleaseAction(prepared(), observed)).toThrow();
  });
  it("holds unknown outcomes and never dispatches them again, but accepts attributed reconciliation", () => {
    const started = transitionReleaseAction(prepared(), { type: "dispatch" });
    const held = transitionReleaseAction(started, { type: "unknown" });
    expect(transitionReleaseAction(held, { type: "unknown" })).toEqual(held);
    expect(() => transitionReleaseAction(held, { type: "dispatch" })).toThrow();
    expect(() =>
      transitionReleaseAction(held, { ...observed, requestDigest: "e".repeat(64) }),
    ).toThrow();
    expect(transitionReleaseAction(held, observed).phase).toBe("observed");
  });
  it("permits cancellation only before an effect and rejects malformed durable states", () => {
    const canceled = transitionReleaseAction(prepared(), { type: "cancel" });
    expect(() => transitionReleaseAction(canceled, { type: "dispatch" })).toThrow();
    expect(() =>
      transitionReleaseAction(transitionReleaseAction(prepared(), { type: "dispatch" }), {
        type: "cancel",
      }),
    ).toThrow();
    expect(() =>
      releaseActionJournalSchema.parse({ identity, phase: "observed", receiptDigest: null }),
    ).toThrow();
    expect(() =>
      releaseActionJournalSchema.parse({ identity, phase: "held", receiptDigest: "c".repeat(64) }),
    ).toThrow();
  });
});
