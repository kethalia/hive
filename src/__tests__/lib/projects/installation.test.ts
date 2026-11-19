import { createHash, generateKeyPairSync } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { issueRepositoryToken, matchesWorkspaceKey } from "@/lib/projects/installation.server";

const repo = { id: 1183966024, name: "kethalia/hive", installationId: 101 };
function provider(scoped = true) {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  vi.stubEnv("HIVE_GITHUB_APP_ID", "17");
  vi.stubEnv(
    "HIVE_GITHUB_APP_PRIVATE_KEY",
    privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  );
  const api = vi.fn(async (_url: string, options: RequestInit) => {
    if (options.method === "DELETE") return new Response(null, { status: 204 });
    expect(JSON.parse(String(options.body))).toEqual({
      repository_ids: [repo.id],
      permissions: { contents: "read" },
    });
    return Response.json({
      token: "fixture-scoped",
      expires_at: new Date(Date.now() + 3600000).toISOString(),
      repositories: [{ id: repo.id, full_name: repo.name }],
      permissions: { contents: "read", metadata: "read", ...(scoped ? {} : { issues: "write" }) },
    });
  });
  vi.stubGlobal("fetch", api);
  return api;
}
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});
it("mints for a single immutable repository ID and an explicit contents permission", async () => {
  const api = provider();
  expect((await issueRepositoryToken(repo, "read")).token).toBe("fixture-scoped");
  expect(api.mock.calls[0][0]).toBe("https://api.github.com/app/installations/101/access_tokens");
});
it("revokes an unexpectedly broad grant before delivery", async () => {
  const api = provider(false);
  await expect(issueRepositoryToken(repo, "read")).rejects.toThrow("Unexpected GitHub grant");
  expect(api.mock.calls[1][0]).toBe("https://api.github.com/installation/token");
});
it("binds the broker authorization to the workspace-specific secret", () => {
  const key = "a".repeat(48);
  const hash = createHash("sha256").update(key).digest("hex");
  expect(matchesWorkspaceKey("Bearer " + key, hash)).toBe(true);
  expect(matchesWorkspaceKey("Bearer " + "b".repeat(48), hash)).toBe(false);
});
