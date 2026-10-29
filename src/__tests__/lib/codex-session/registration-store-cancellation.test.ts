import { describe, expect, it, vi } from "vitest";
import { lockActiveRegistration } from "@/lib/codex-session/registration-store.server";

function fixture() {
  const controller = new AbortController();
  const registration = {
    id: "registration",
    slotId: "slot",
    generation: 1,
    revokedAt: null,
    expiresAt: new Date("2030-01-01T00:00:00Z"),
    binding: {
      hiveUserId: "owner",
      coderUserId: "coder",
      ownerId: "coder",
      coderOrigin: "https://coder.example",
      projects: [],
    },
  };
  const tx = {
    codexHostRegistration: {
      findUnique: vi.fn().mockResolvedValue(registration),
      findUniqueOrThrow: vi.fn().mockResolvedValue(registration),
    },
    codexHostSlot: {
      findUniqueOrThrow: vi
        .fn()
        .mockResolvedValue({ id: "slot", activeRegistrationId: "registration", generation: 1 }),
    },
    $queryRaw: vi
      .fn()
      .mockResolvedValueOnce([{ id: "slot" }])
      .mockResolvedValueOnce([{ id: "registration" }])
      .mockResolvedValueOnce([{ now: new Date("2026-10-29T00:00:00Z") }]),
    user: {
      findUnique: vi
        .fn()
        .mockResolvedValue({ coderUserId: "coder", coderUrl: "https://coder.example" }),
    },
    deliveryProject: { findMany: vi.fn().mockResolvedValue([]) },
  };
  const run = () =>
    lockActiveRegistration(
      tx as unknown as Parameters<typeof lockActiveRegistration>[0],
      { ownerId: "owner", registrationId: "registration" },
      controller.signal,
    );
  return { tx, controller, registration, run };
}

describe("registration authorization cancellation between SQL reads", () => {
  it("does not start slot-lock SQL after an aborted registration read drains", async () => {
    const f = fixture();
    f.tx.codexHostRegistration.findUnique.mockImplementationOnce(async () => {
      f.controller.abort();
      return f.registration;
    });
    await expect(f.run()).rejects.toThrow();
    expect(f.tx.$queryRaw).not.toHaveBeenCalled();
  });
  it("does not read the slot after an already-running lock query completes after cancellation", async () => {
    const f = fixture();
    f.tx.$queryRaw.mockReset().mockImplementationOnce(async () => {
      f.controller.abort();
      return [{ id: "slot" }];
    });
    await expect(f.run()).rejects.toThrow();
    expect(f.tx.codexHostSlot.findUniqueOrThrow).not.toHaveBeenCalled();
  });
  it("does not start project authorization SQL after an aborted owner read drains", async () => {
    const f = fixture();
    f.tx.user.findUnique.mockImplementationOnce(async () => {
      f.controller.abort();
      return { coderUserId: "coder", coderUrl: "https://coder.example" };
    });
    await expect(f.run()).rejects.toThrow();
    expect(f.tx.deliveryProject.findMany).not.toHaveBeenCalled();
  });
});
