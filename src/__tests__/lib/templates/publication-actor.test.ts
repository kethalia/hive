import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@hive/db";
import { afterEach, expect, it, vi } from "vitest";
import { getCoderClientForUser } from "@/lib/coder/user-client";
import { authorizeTemplateActor } from "@/lib/templates/publication-actor";

vi.mock("@/lib/coder/user-client", () => ({ getCoderClientForUser: vi.fn() }));
afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});
it("authorizes OAuth publication from its current credential expiry without any legacy key", async () => {
  const origin = "https://coder.example.com";
  vi.stubEnv("CODER_URL", origin);
  const identity = { ownerId: randomUUID(), coderUserId: randomUUID(), sessionId: randomUUID() };
  const expiry = new Date(Date.now() + 60000);
  vi.mocked(getCoderClientForUser).mockResolvedValue({
    getBaseUrl: () => origin,
    getSessionToken: () => "oauth-access",
    getCredentialExpiresAt: () => expiry,
    getCredentialSource: () => "oauth",
  } as never);
  const coderToken = {
    findUnique: vi.fn(() => {
      throw Error("legacy query forbidden");
    }),
  };
  const db = {
    session: {
      findUnique: vi.fn(async () => ({
        userId: identity.ownerId,
        expiresAt: expiry,
        user: { coderUserId: identity.coderUserId, coderUrl: origin },
      })),
    },
    coderToken,
  };
  await expect(
    authorizeTemplateActor(db as unknown as PrismaClient, identity, new AbortController().signal),
  ).resolves.toMatchObject({
    token: "oauth-access",
    credentialSource: "oauth",
    tokenExpiresAt: expiry,
  });
  expect(coderToken.findUnique).not.toHaveBeenCalled();
});
