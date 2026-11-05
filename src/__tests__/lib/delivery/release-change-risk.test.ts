import { describe, expect, it } from "vitest";
import { GitHubReleaseChangeRisk } from "@/lib/delivery/release-change-risk.server";

const request = {
  repositoryId: "1",
  pullRequestId: "2",
  pullNumber: 3,
  headSha: "a".repeat(40),
  baseSha: "b".repeat(40),
  baseRef: "preview",
  rulesDigest: "c".repeat(64),
  method: "squash",
};
const pull = {
  id: 2,
  number: 3,
  state: "open",
  draft: false,
  changed_files: 1,
  head: { sha: request.headSha, repo: { id: 1 } },
  base: { sha: request.baseSha, ref: "preview", repo: { id: 1 } },
};
const config = { owner: "test", name: "repo", allowedPrefixes: ["src/"] };
function provider(
  files: unknown,
  next = false,
  lastPull = pull,
  options = config as typeof config & { databasePrefixes?: string[] },
) {
  let calls = 0;
  const instance = new GitHubReleaseChangeRisk(options, "fixture", async (url, init) => {
    calls++;
    expect(init?.redirect).toBe("error");
    expect(String(url)).toMatch(/^https:\/\/api\.github\.com\/repos\/test\/repo\/pulls\/3/);
    if (String(url).includes("/files?"))
      return Response.json(files, {
        headers: next ? { link: '<https://api.github.com/next>; rel="next"' } : {},
      });
    return Response.json(calls === 1 ? pull : lastPull);
  });
  return { instance, calls: () => calls };
}
describe("GitHub release path risk", () => {
  it("binds a complete listing to current repository, head and tested base", async () => {
    const p = provider([{ filename: "src/app.ts", status: "modified" }]);
    const result = await p.instance.inspect(request, new AbortController().signal);
    expect(result.evidence.riskClass).toBe("application_only");
    expect(result.digest).toMatch(/^[a-f0-9]{64}$/);
    expect(p.calls()).toBe(3);
  });
  it("holds truncated listings, moved sources, and renames from outside scope", async () => {
    const signal = new AbortController().signal;
    await expect(
      provider([{ filename: "src/app.ts", status: "modified" }], true).instance.inspect(
        request,
        signal,
      ),
    ).rejects.toThrow("release_risk_incomplete");
    await expect(
      provider([
        {
          filename: "src/app.ts",
          status: "renamed",
          previous_filename: "packages/db/schema.prisma",
        },
      ]).instance.inspect(request, signal),
    ).rejects.toThrow("release_risk_out_of_scope");
    await expect(
      provider([{ filename: "src/app.ts", status: "modified" }], false, {
        ...pull,
        base: { ...pull.base, sha: "d".repeat(40) },
      }).instance.inspect(request, signal),
    ).rejects.toThrow("release_risk_scope_changed");
    await expect(provider([], false).instance.inspect(request, signal)).rejects.toThrow(
      "release_risk_incomplete",
    );
  });
  it("classifies both sides of a rename under enrolled database prefixes", async () => {
    const options = { ...config, databasePrefixes: ["packages/db/"] };
    const result = await provider(
      [
        {
          filename: "src/app.ts",
          status: "renamed",
          previous_filename: "packages/db/schema.prisma",
        },
      ],
      false,
      pull,
      options,
    ).instance.inspect(request, new AbortController().signal);
    expect(result.evidence.riskClass).toBe("database");
  });
});
