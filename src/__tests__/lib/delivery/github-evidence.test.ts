import { describe, expect, it, vi } from "vitest";
import { GitHubEvidenceAdapter } from "@/lib/delivery/github-evidence.server";
import { isGitHubSerializationConflict } from "@/lib/delivery/github-persistence.server";
import { githubFixture } from "./github-fixture";

function fixture() {
  const data = githubFixture(),
    collect = vi.fn(async () => structuredClone(data.snapshot));
  const adapter = new GitHubEvidenceAdapter({ collect }, () => data.now);
  return { ...data, collect, observe: () => adapter.observe(data.target, data.policy) };
}
describe("authoritative GitHub source normalization", () => {
  it("only retries observed Prisma transaction or raw SQL40001 serialization errors across runtime constructors", () => {
    const base = { name: "PrismaClientKnownRequestError", clientVersion: "6.19.3" };
    expect(isGitHubSerializationConflict({ ...base, code: "P2034" })).toBe(true);
    expect(isGitHubSerializationConflict({ ...base, code: "P2010", meta: { code: "40001" } })).toBe(
      true,
    );
    for (const value of [
      { ...base, code: "P2010", meta: { code: "23505" } },
      { ...base, code: "P2002" },
      { code: "P2034" },
      { ...base, code: "P2034", clientVersion: "unknown" },
      new Error("40001"),
    ])
      expect(isGitHubSerializationConflict(value)).toBe(false);
  });
  it("fetches the exact stable target and binds app/workflow/job/PR IDs and authoritative ordering", async () => {
    const f = fixture(),
      result = await f.observe();
    expect(f.collect).toHaveBeenCalledWith(f.target);
    expect(result.eligibility.eligible).toBe(true);
    expect(result.checks[0]).toMatchObject({
      producer: "github-actions:42:workflow:61:app:81",
      runSequence: 9,
      runAttempt: 2,
      status: "success",
      sourceSha: f.target.expectedHeadSha,
      sourceUpdatedAt: Date.parse(f.snapshot.workflowRuns[0].updatedAt),
    });
    expect(result.reviews[0]).toMatchObject({
      producer: "github-codex-review:42:user:10:app:11",
      status: "completed",
      independent: true,
    });
    expect(result.checks[0].remoteId).toContain(":run:60:attempt:2:job:70:check:80");
  });
  it.each([
    "account",
    "repository",
    "head",
    "pull",
  ])("rejects mismatched %s identity rather than relabelling evidence", async (field) => {
    const f = fixture();
    if (field === "account") f.snapshot.providerAccountId = "999";
    if (field === "repository") f.snapshot.repository.id = "999";
    if (field === "head") f.snapshot.pullRequest.headSha = "b".repeat(40);
    if (field === "pull") f.snapshot.pullRequest.number = 99;
    await expect(f.observe()).rejects.toThrow("github_source_binding_mismatch");
  });
  it("a newer pending run supersedes an old success even when old success completes later", async () => {
    const f = fixture();
    f.snapshot.workflowRuns[0].updatedAt = new Date(f.now - 200).toISOString();
    f.snapshot.workflowRuns.push({
      ...f.snapshot.workflowRuns[0],
      id: "100",
      runNumber: 10,
      runAttempt: 1,
      checkSuiteId: "101",
      updatedAt: new Date(f.now - 500).toISOString(),
      status: "queued",
      conclusion: null,
      jobs: [],
    });
    const result = await f.observe();
    expect(result.eligibility.eligible).toBe(false);
    expect(result.checks.find((check) => check.runSequence === 10)?.status).toBe("pending");
  });
  it.each([
    "app",
    "slug",
    "attempt",
    "suite",
    "url",
    "duplicate-job",
  ])("cannot pass mismatched or ambiguous %s check provenance", async (field) => {
    const f = fixture(),
      run = f.snapshot.workflowRuns[0];
    if (field === "app") f.snapshot.checks[0].appId = "999";
    if (field === "slug") f.snapshot.checks[0].appSlug = "other-app";
    if (field === "attempt") run.jobs[0].runAttempt = 1;
    if (field === "suite") f.snapshot.checks[0].checkSuiteId = "999";
    if (field === "url") run.jobs[0].checkRunUrl = "https://attacker.invalid/check-runs/80";
    if (field === "duplicate-job") run.jobs.push({ ...run.jobs[0], id: "71" });
    const result = await f.observe();
    expect(result.eligibility.eligible).toBe(false);
    expect(result.checks.every((check) => check.status !== "success")).toBe(true);
  });
  it("uses source timestamps, blocks future remote updates and never promotes neutral/skipped status", async () => {
    const f = fixture();
    f.snapshot.workflowRuns[0].updatedAt = new Date(f.now + 1000).toISOString();
    expect((await f.observe()).eligibility.eligible).toBe(false);
    f.snapshot.workflowRuns[0].updatedAt = new Date(f.now - 1000).toISOString();
    f.snapshot.workflowRuns[0].jobs[0].conclusion = "neutral";
    f.snapshot.checks[0].conclusion = "neutral";
    expect((await f.observe()).checks[0].status).toBe("skipped");
  });
  it.each([
    "user",
    "app",
    "head",
    "malformed",
    "duplicate",
    "author",
  ])("does not accept spoofed, stale or ambiguous %s review summary", async (field) => {
    const f = fixture(),
      comment = f.snapshot.reviewSummaries[0];
    if (field === "user") comment.userId = "999";
    if (field === "app") comment.appId = "999";
    if (field === "head") comment.marker!.code_review.commit_sha = "b".repeat(40);
    if (field === "malformed") {
      comment.marker = null;
      comment.markerCount = 2;
    }
    if (field === "duplicate")
      f.snapshot.reviewSummaries.push({ ...comment, id: "92", bodyDigest: "d".repeat(64) });
    if (field === "author") f.snapshot.pullRequest.authorId = comment.userId;
    expect((await f.observe()).eligibility.eligible).toBe(false);
  });
  it("unresolved threads, including outdated threads, and an outstanding human change request block a clean bot summary", async () => {
    const f = fixture();
    f.snapshot.reviewThreads[0].isResolved = false;
    f.snapshot.reviewThreads[0].isOutdated = true;
    expect((await f.observe()).eligibility.eligible).toBe(false);
    f.snapshot.reviewThreads[0].isResolved = true;
    f.snapshot.reviews[0].state = "CHANGES_REQUESTED";
    expect((await f.observe()).reviews[0].unresolvedFindings).toBe(1);
  });
  it("requires each configured review identity and independent formal approval", async () => {
    const f = fixture();
    f.policy.formalReviewers = [{ userId: "999", criterionIds: ["C1"] }];
    expect((await f.observe()).eligibility.eligible).toBe(false);
    f.policy.codexReview = null;
    f.policy.formalReviewers = [{ userId: "9", criterionIds: ["C1"] }];
    expect((await f.observe()).eligibility.eligible).toBe(true);
    f.snapshot.pullRequest.authorId = "9";
    expect((await f.observe()).eligibility.eligible).toBe(false);
  });
  it("rejects incomplete snapshots, duplicate remote identities and expired source observations", async () => {
    const f = fixture();
    f.snapshot.checks.push({ ...f.snapshot.checks[0] });
    await expect(f.observe()).rejects.toThrow("github_source_ambiguous");
    f.snapshot.checks.pop();
    f.snapshot.observedAt = new Date(f.now - 61000).toISOString();
    await expect(f.observe()).rejects.toThrow("github_observation_expired");
    f.snapshot.observedAt = new Date(f.now - 100).toISOString();
    f.collect.mockResolvedValueOnce({ ...f.snapshot, collectionsComplete: false } as never);
    await expect(f.observe()).rejects.toThrow();
  });
  it("closed/draft PRs remain observation blockers", async () => {
    const f = fixture();
    f.snapshot.pullRequest.draft = true;
    expect((await f.observe()).eligibility.blockers).toContain("pull-draft");
    f.snapshot.pullRequest.draft = false;
    f.snapshot.pullRequest.state = "closed";
    expect((await f.observe()).eligibility.blockers).toContain("pull-not-open");
  });
});
