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
    parameters: { required_approving_review_count: 0 },
    ruleset_id: 9,
    ruleset_source_type: "Repository",
    ruleset_source: "test/repo",
  },
];
function fixture(
  options: {
    bypass?: boolean;
    drift?: boolean;
    next?: boolean;
    protection?: unknown;
    protectionStatus?: number;
    rules?: Record<string, unknown>[];
    ruleDrift?: boolean;
    setDrift?: boolean;
  } = {},
) {
  let branchReads = 0,
    ruleReads = 0,
    setReads = 0;
  const fetcher: typeof fetch = async (raw, init) => {
    const url = String(raw);
    expect(init?.redirect).toBe("error");
    if (url.endsWith("/repos/test/repo")) return Response.json({ id: 1 });
    if (url.includes("/branches/preview/protection")) {
      const value = Object.hasOwn(options, "protection") ? options.protection : protection;
      return Response.json(value, {
        status: options.protectionStatus ?? (value === null ? 404 : 200),
      });
    }
    if (url.endsWith("/branches/preview")) {
      branchReads++;
      return Response.json({
        commit: { sha: options.drift && branchReads > 1 ? "d".repeat(40) : request.baseSha },
      });
    }
    if (url.includes("/rules/branches/")) {
      ruleReads++;
      const effective = structuredClone(options.rules ?? rules);
      if (options.ruleDrift && ruleReads > 1) effective.pop();
      return Response.json(effective, {
        headers: options.next ? { link: '<https://api.github.com/next>; rel="next"' } : {},
      });
    }
    if (url.includes("/rulesets/9")) {
      setReads++;
      return Response.json({
        id: 9,
        enforcement: "active",
        bypass_actors: options.bypass ? [{ actor_type: "Team" }] : [],
        name: options.setDrift && setReads > 1 ? "changed" : "enrolled",
      });
    }
    if (url.endsWith("/pulls/3"))
      return Response.json({
        id: 2,
        number: 3,
        state: "open",
        merge_commit_sha: "d".repeat(40),
        head: { sha: request.headSha },
        base: { sha: request.baseSha, ref: request.baseRef },
      });
    if (url.endsWith(`/commits/${"d".repeat(40)}`))
      return Response.json({
        sha: "d".repeat(40),
        commit: { tree: { sha: "e".repeat(40) } },
        parents: [{ sha: request.baseSha }, { sha: request.headSha }],
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

const rulesetOnly = [
  { ...rules[0], parameters: { required_approving_review_count: 0 } },
  {
    ...rules[0],
    type: "required_status_checks",
    parameters: {
      strict_required_status_checks_policy: true,
      required_status_checks: [{ context: "ci", integration_id: 7 }],
    },
  },
];
const inspect = (options: Parameters<typeof fixture>[0]) =>
  fixture(options).inspect(request, new AbortController().signal);
describe("effective rulesets with enrolled independent review", () => {
  it("accepts required PR with zero formal approvals and strict app-bound CI without classic protection", async () => {
    const result = await inspect({ protection: null, rules: rulesetOnly });
    expect(result.evidence.protection).toBeNull();
    expect(result.evidence.effective).toEqual({
      required_pull_request: true,
      required_status_checks: { strict: true, checks: [{ context: "ci", app_id: 7 }] },
    });
    const policy = {
      version: "reviewed",
      maxAgeMs: 900000,
      checks: [
        {
          name: "ci",
          workflowId: "5",
          appId: "7",
          appSlug: "github-actions" as const,
          events: ["pull_request" as const],
          criterionIds: ["repo:ci"],
        },
      ],
      codexReview: { userId: "199175422", appId: "1144995", criterionIds: ["repo:codex-review"] },
      formalReviewers: [],
    };
    expect(
      (
        await fixture({ protection: null, rules: rulesetOnly }).inspectMerge(
          request,
          policy,
          new AbortController().signal,
        )
      ).mergeSha,
    ).toBe("d".repeat(40));
    await expect(
      fixture({ protection: null, rules: rulesetOnly }).inspectMerge(
        request,
        { ...policy, checks: [{ ...policy.checks[0], appId: "8" }] },
        new AbortController().signal,
      ),
    ).rejects.toThrow();
  });
  it("accepts classic zero formal approvals and layered classic PR/ruleset strict checks", async () => {
    const zero = structuredClone(protection);
    zero.required_pull_request_reviews.required_approving_review_count = 0;
    await expect(inspect({ protection: zero, rules: [] })).resolves.toHaveProperty("digest");
    await expect(
      inspect({ protection: { ...zero, required_status_checks: null }, rules: [rulesetOnly[1]] }),
    ).resolves.toHaveProperty("digest");
  });
  it("does not waive PR, strict checks, producer binding, provider errors, bypass actors or drift", async () => {
    for (const options of [
      { protection: null, rules: [] },
      { protection: null, rules: [rulesetOnly[0]] },
      { protection: null, rules: [rulesetOnly[1]] },
      {
        protection: null,
        rules: [
          rulesetOnly[0],
          {
            ...rulesetOnly[1],
            parameters: {
              strict_required_status_checks_policy: false,
              required_status_checks: [{ context: "ci", integration_id: 7 }],
            },
          },
        ],
      },
      {
        protection: null,
        rules: [
          rulesetOnly[0],
          {
            ...rulesetOnly[1],
            parameters: {
              strict_required_status_checks_policy: true,
              required_status_checks: [{ context: "ci", integration_id: null }],
            },
          },
        ],
      },
      { protection: null, protectionStatus: 403, rules: rulesetOnly },
      { protection: null, rules: rulesetOnly, bypass: true },
      { protection: null, rules: rulesetOnly, next: true },
      { protection: null, rules: rulesetOnly, drift: true },
      { protection: null, rules: rulesetOnly, ruleDrift: true },
      { protection: null, rules: rulesetOnly, setDrift: true },
      { protection: { ...protection, enforce_admins: { enabled: false } }, rules: rulesetOnly },
      {
        protection: {
          ...protection,
          required_pull_request_reviews: {
            required_approving_review_count: 0,
            bypass_pull_request_allowances: { users: [{}], teams: [], apps: [] },
          },
        },
        rules: rulesetOnly,
      },
    ])
      await expect(inspect(options)).rejects.toThrow();
  });
});
