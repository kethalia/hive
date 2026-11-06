import { describe, expect, it } from "vitest";
import { GitHubReleaseRules } from "@/lib/delivery/release-github-rules.server";

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
const protection = {
  required_status_checks: { strict: true, checks: [{ context: "ci", app_id: 7 }] },
  enforce_admins: { enabled: true },
  required_pull_request_reviews: {
    required_approving_review_count: 1,
    bypass_pull_request_allowances: { users: [], teams: [], apps: [] },
  },
};
const rules = [
  {
    type: "pull_request",
    ruleset_id: 9,
    ruleset_source_type: "Repository",
    ruleset_source: "test/repo",
  },
];
function fixture(options: { bypass?: boolean; drift?: boolean; next?: boolean } = {}) {
  let branchReads = 0;
  const fetcher: typeof fetch = async (raw, init) => {
    const url = String(raw);
    expect(init?.redirect).toBe("error");
    if (url.endsWith("/repos/test/repo")) return Response.json({ id: 1 });
    if (url.includes("/branches/preview/protection")) return Response.json(protection);
    if (url.endsWith("/branches/preview")) {
      branchReads++;
      return Response.json({
        commit: { sha: options.drift && branchReads > 1 ? "d".repeat(40) : request.baseSha },
      });
    }
    if (url.includes("/rules/branches/"))
      return Response.json(rules, {
        headers: options.next ? { link: '<https://api.github.com/next>; rel="next"' } : {},
      });
    if (url.includes("/rulesets/9"))
      return Response.json({
        id: 9,
        enforcement: "active",
        bypass_actors: options.bypass ? [{ actor_type: "Team" }] : [],
      });
    throw Error("unexpected");
  };
  return new GitHubReleaseRules({ owner: "test", name: "repo" }, "fixture", fetcher);
}
describe("GitHub release branch rules", () => {
  it("reads strict classic protection, active rule sources and exact tested base", async () => {
    const result = await fixture().inspect(request, new AbortController().signal);
    expect(result.digest).toMatch(/^[a-f0-9]{64}$/);
    expect(result.evidence.baseRef).toBe("preview");
  });
  it("holds bypass actors, base drift and incomplete pagination", async () => {
    for (const opts of [{ bypass: true }, { drift: true }, { next: true }])
      await expect(fixture(opts).inspect(request, new AbortController().signal)).rejects.toThrow();
  });
});
