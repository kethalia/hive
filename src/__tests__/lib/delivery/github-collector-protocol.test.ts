import { generateKeyPairSync, randomUUID, verify } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import {
  githubChallengeRequestSchema,
  githubSourceEnvelopeSchema,
  githubTransportProofPayload,
} from "@/lib/delivery/github-transport-contracts";
import { createDeliveryGitHubCollector } from "../../../../templates/ai-dev-k8s/scripts/delivery-github-collector.mjs";
import { githubFixture } from "./github-fixture";

it("real collector signs advanced-source requests accepted by both server schemas", async () => {
  const directory = mkdtempSync(join(tmpdir(), "hive-collector-protocol-"));
  try {
    const keys = generateKeyPairSync("ed25519"),
      data = githubFixture(),
      projectId = randomUUID(),
      threadId = randomUUID(),
      sourceContext = {
        revisionId: randomUUID(),
        version: 2,
        headSha: data.target.expectedHeadSha,
      },
      checkoutBinding = {
        projectId,
        preparationIntentId: randomUUID(),
        repositoryId: data.target.providerRepositoryId,
        revision: "b".repeat(40),
        leaseId: randomUUID(),
        leaseGeneration: 1,
      },
      registration = {
        id: randomUUID(),
        serverInstanceId: randomUUID(),
        expiresAt: Date.now() + 60000,
        threads: [{ projectId, threadId }],
      };
    const phases: string[] = [];
    const collector = createDeliveryGitHubCollector({
      enabled: true,
      sourceProtocol: 1,
      stateDirectory: directory,
      hiveOrigin: "https://hive.invalid",
      hostPrivateKeyPem: keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
      currentRegistration: () => registration,
      currentProjectContext: () => checkoutBinding,
      currentAcceptedSource: async () => sourceContext,
      runHelper: async (target: unknown) => {
        expect(target).toEqual(data.target);
        return data.snapshot;
      },
      fetchImpl: async (url: string, init: RequestInit) => {
        const challenge = url.endsWith("/challenge"),
          value = (challenge ? githubChallengeRequestSchema : githubSourceEnvelopeSchema).parse(
            JSON.parse(String(init.body)),
          ),
          phase = challenge ? "challenge" : "snapshot";
        phases.push(phase);
        expect(value.sourceContext).toEqual(sourceContext);
        expect(value.checkoutBinding).toEqual(checkoutBinding);
        expect(
          verify(
            null,
            Buffer.from(githubTransportProofPayload(phase, value)),
            keys.publicKey,
            Buffer.from(value.proof, "base64url"),
          ),
        ).toBe(true);
        return Response.json(
          challenge
            ? {
                schemaVersion: 1,
                action: value.action,
                id: "requestId" in value ? value.requestId : "",
                nonce: "c".repeat(64),
                registrationId: registration.id,
                managerBindingId: randomUUID(),
                target: data.target,
                policyDigest: "d".repeat(64),
                expiresAt: Date.now() + 59000,
              }
            : { evidenceIds: ["fixture-evidence"] },
        );
      },
    });
    expect(
      await collector.refresh({
        managerThreadId: threadId,
        taskId: randomUUID(),
        stepId: randomUUID(),
        requestId: randomUUID(),
      }),
    ).toEqual({ evidenceIds: ["fixture-evidence"] });
    expect(phases).toEqual(["challenge", "snapshot"]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
