import { generateKeyPairSync, sign, verify } from "node:crypto";
import { describe, expect, it } from "vitest";
import { githubSourceDigest } from "@/lib/delivery/github-evidence.server";
import { sourceTransportProofPayload } from "@/lib/delivery/source-transport-contracts";
import { sourcePublisherProofPayload } from "../../../../templates/ai-dev-k8s/scripts/delivery-source-publisher.mjs";
import { sourceDigest } from "../../../../templates/ai-dev-k8s/scripts/delivery-source-publisher-journal.mjs";

describe("installed source signing protocol matches server canonical bytes", () => {
  for (const phase of ["policy", "challenge", "publish"] as const)
    it(phase, () => {
      const unsigned = {
        schemaVersion: 1,
        operationId: "11111111-1111-4111-8111-111111111111",
        policy: { authorName: "Hive Éditeur", baseBranch: "main" },
        manifest: {
          files: [
            {
              path: "src/file.ts",
              contentDigest: "a".repeat(64),
              size: 10,
              mode: "100644",
              blobSha: "b".repeat(40),
            },
          ],
          deletions: [],
        },
      };
      const host = sourcePublisherProofPayload(phase, unsigned),
        server = sourceTransportProofPayload(phase, unsigned);
      expect(host).toBe(server);
      expect(sourceDigest(unsigned)).toBe(githubSourceDigest(unsigned));
      const keys = generateKeyPairSync("ed25519"),
        signature = sign(null, Buffer.from(host), keys.privateKey);
      expect(verify(null, Buffer.from(server), keys.publicKey, signature)).toBe(true);
      expect(sourcePublisherProofPayload(phase, { ...unsigned, proof: "ignored" })).toBe(server);
    });
});
