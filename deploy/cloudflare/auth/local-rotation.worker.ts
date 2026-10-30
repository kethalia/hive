// Test-only entrypoint. Production main remains auth/worker.ts; no real store or
// provider is injected here, and no external request is made by this proof.
import { encrypt, tryDecrypt } from "@hive/auth";
import { boundedCoderJson } from "../../../services/auth/src/auth/bounded-coder-json";
import type {
  RotationClaim,
  RotationOperation,
  RotationToken,
} from "../../../services/auth/src/auth/rotation-contracts";
import {
  awaitRotationProvider,
  type RotationStore,
  runCredentialRotation,
} from "../../../services/auth/src/auth/rotation-scheduler";

export default {
  async fetch(request: Request, env: { PROOF_BEARER?: string }) {
    if (
      request.method !== "POST" ||
      new URL(request.url).pathname !== "/__local-rotation" ||
      !env.PROOF_BEARER ||
      request.headers.get("Authorization") !== `Bearer ${env.PROOF_BEARER}`
    )
      return new Response(null, { status: 404 });
    const key = "a".repeat(64),
      origin = "https://coder.rotation-proof.invalid",
      day = 86400_000;
    const userId = crypto.randomUUID(),
      coderUserId = crypto.randomUUID();
    const encrypted = encrypt("fixture-old-credential", key);
    const tokens: RotationToken[] = Array.from({ length: 2 }, () => ({
      id: crypto.randomUUID(),
      userId,
      version: 1,
      remoteKeyId: "oldhivekey",
      ciphertext: new Uint8Array(encrypted.ciphertext),
      iv: new Uint8Array(encrypted.iv),
      authTag: new Uint8Array(encrypted.authTag),
      createdAt: new Date(Date.now() - 29 * day),
      updatedAt: new Date(Date.now() - 29 * day),
      expiresAt: new Date(Date.now() + day),
      user: {
        id: userId,
        coderUserId,
        coderUrl: origin,
        username: "fixture",
        email: "fixture@example.invalid",
        createdAt: new Date(),
        updatedAt: new Date(),
        terminalControlsBeyondMobile: false,
      },
    }));
    let index = 0,
      commits = 0,
      uncertain = 0,
      removed = 0,
      created = 0;
    const claim: RotationClaim = {
      id: crypto.randomUUID(),
      configuredOrigin: origin,
      holder: crypto.randomUUID(),
      generation: 1,
      afterId: null,
    };
    const store: RotationStore = {
      claim: async () => claim,
      next: async () => tokens[index] ?? null,
      prepare: async (_claim, token) =>
        ({
          id: crypto.randomUUID(),
          ownerId: userId,
          tokenId: token.id,
          tokenVersion: 1,
          coderUserId,
          configuredOrigin: origin,
          holder: claim.holder,
          generation: 1,
        }) satisfies RotationOperation,
      commit: async (_claim, _op, _token, candidate) => {
        const stored = encrypt(candidate.token, key);
        if (!tryDecrypt(stored, key).ok) throw new Error("fixture_crypto_failed");
        commits++;
      },
      finish: async (_op, phase) => {
        if (phase === "uncertain") uncertain++;
      },
      advance: async () => {
        index++;
      },
      release: async () => {},
    };
    const result = await runCredentialRotation({
      enabled: true,
      store,
      createKey: async () => {
        created++;
        return created === 1
          ? null
          : {
              id: "abcdefghij",
              token: `abcdefghij-${"k".repeat(22)}`,
              expiresAt: new Date(Date.now() + 30 * day),
            };
      },
      deleteKey: async () => {
        removed++;
        return true;
      },
    });
    const abort = new AbortController();
    const stalled = awaitRotationProvider(new Promise(() => {}), abort.signal).then(
      () => false,
      () => true,
    );
    abort.abort();
    const bodyAbort = new AbortController();
    const body = boundedCoderJson(
      new Response(
        new ReadableStream({
          pull: () => new Promise(() => {}),
          cancel: () => new Promise(() => {}),
        }),
      ),
      bodyAbort.signal,
    ).then(
      () => false,
      () => true,
    );
    bodyAbort.abort();
    const checks = {
      controllerBounds:
        result.enabled &&
        "minted" in result &&
        result.minted === 2 &&
        result.rotated === 1 &&
        result.held === 1,
      unknownRetained: uncertain === 1,
      verifiedReplacement: commits === 1 && removed === 1,
      providerDeadline: await stalled,
      stalledBodyAndCancel: await body,
    };
    return Response.json({
      ok: Object.values(checks).every(Boolean),
      checks,
      scope:
        "workerd actual controller with explicit store/provider doubles; no SQL/provider proof",
    });
  },
};
