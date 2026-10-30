import { generateKeyPairSync, sign, verify } from "node:crypto";
import { expect, it } from "vitest";
import { sourceStateProofPayload } from "@/lib/delivery/source-state-contracts";
import { sourceStateClientProofPayload } from "../../../../templates/ai-dev-k8s/scripts/delivery-source-state-client.mjs";

it("fixed host state signing bytes match the server's separate read-only action/path", () => {
  const value = {
    schemaVersion: 1,
    action: "read_source_state",
    taskId: "11111111-1111-4111-8111-111111111111",
    operationId: "22222222-2222-4222-8222-222222222222",
    checkoutBinding: { leaseGeneration: 1, revision: "a".repeat(40) },
  };
  const host = sourceStateClientProofPayload(value),
    server = sourceStateProofPayload(value);
  expect(host).toBe(server);
  const keys = generateKeyPairSync("ed25519"),
    signature = sign(null, Buffer.from(host), keys.privateKey);
  expect(verify(null, Buffer.from(server), keys.publicKey, signature)).toBe(true);
});
