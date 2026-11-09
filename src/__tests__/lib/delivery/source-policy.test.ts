import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { resolveControllerSourcePolicy } from "@/lib/delivery/source-policy.server";
import { sourcePublicationPolicySchema } from "@/lib/delivery/source-transport-contracts";

const policy = {
  version: "v1",
  authorName: "Hive",
  authorEmail: "codex@kethalia.com",
  baseBranch: "main",
  allowedPrefixes: ["src"],
  maxFiles: 5,
  maxFileBytes: 1024,
  maxBytes: 4096,
};
describe("controller-owned publication policy", () => {
  it("rejects multiline/control author identities and unsafe refs", () => {
    expect(sourcePublicationPolicySchema.parse(policy)).toEqual(policy);
    for (const authorName of [
      " ",
      "Hive\nOther",
      "Hive\u0085Other",
      "Hive\u2028Other",
      "Hive<other>",
    ])
      expect(() => sourcePublicationPolicySchema.parse({ ...policy, authorName })).toThrow();
    for (const authorEmail of ["a\nb@example.com", "a b@example.com", "a@x.com\r"])
      expect(() => sourcePublicationPolicySchema.parse({ ...policy, authorEmail })).toThrow();
    for (const baseBranch of ["../main", "main.lock", "a//b", "x."])
      expect(() => sourcePublicationPolicySchema.parse({ ...policy, baseBranch })).toThrow();
  });
  it("fails closed for missing, unbounded and absent task configuration", () => {
    const scope = { ownerId: randomUUID(), taskId: randomUUID(), repositoryId: "123" };
    for (const raw of [
      undefined,
      "x".repeat(65537),
      "{",
      "{}",
      JSON.stringify({ [scope.taskId]: { ownerId: randomUUID(), repositoryId: "123", policy } }),
    ])
      expect(() => resolveControllerSourcePolicy(scope, () => raw)).toThrow();
    expect(
      resolveControllerSourcePolicy(scope, () =>
        JSON.stringify({ [scope.taskId]: { ownerId: scope.ownerId, repositoryId: "123", policy } }),
      ),
    ).toEqual(policy);
  });
});
