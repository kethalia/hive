import { withHivePublicOrigin } from "@hive/auth/hive-origin";
import { afterEach, expect, it, vi } from "vitest";
import { GET } from "@/app/api/app-preview-build/route";

const revision = "a".repeat(40);
const origin = "https://codex-task.hive-preview.kethalia.com";

function reportedBuild(mode: string, publicOrigin: string, sha: string) {
  vi.stubEnv("HIVE_NATIVE_MODE", mode);
  vi.stubEnv("HIVE_PROVIDER_BUILD_BRANCH", "codex/task");
  vi.stubEnv("HIVE_PROVIDER_BUILD_SHA", sha);
  return withHivePublicOrigin(publicOrigin, GET);
}

afterEach(() => vi.unstubAllEnvs());

it("reports the provider build only from its native preview origin", async () => {
  const response = reportedBuild("preview", origin, revision);
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(await response.json()).toEqual({ branch: "codex/task", revision });
});

it.each([
  ["production", "https://hive.kethalia.com", revision],
  ["preview", "https://another-branch.hive-preview.kethalia.com", revision],
  ["preview", origin, ""],
])("rejects missing or mismatched preview build identity for %s %s", (mode, publicOrigin, sha) => {
  expect(reportedBuild(mode, publicOrigin, sha).status).toBe(404);
});
