import type {
  GitHubEvidencePolicy,
  GitHubSnapshot,
  GitHubSourceTarget,
} from "@/lib/delivery/github-contracts";

export const githubFixture = (now = Date.now()) => {
  const stamp = new Date(now - 1000).toISOString(),
    sha = "a".repeat(40);
  const target: GitHubSourceTarget = {
    schemaVersion: 1,
    providerRepositoryId: "42",
    providerAccountId: "7",
    fullName: "owner/repo",
    pullNumber: 5,
    expectedHeadSha: sha,
  };
  const policy: GitHubEvidencePolicy = {
    version: "github-fixture-v1",
    maxAgeMs: 60000,
    checks: [
      {
        name: "Test",
        workflowId: "61",
        appId: "81",
        appSlug: "github-actions",
        events: ["pull_request"],
        criterionIds: ["C1"],
      },
    ],
    codexReview: { userId: "10", appId: "11", criterionIds: ["C1"] },
    formalReviewers: [],
  };
  const snapshot: GitHubSnapshot = {
    schemaVersion: 1,
    provider: "github",
    providerAccountId: "7",
    repository: { id: "42", fullName: "owner/repo" },
    pullRequest: {
      id: "50",
      number: 5,
      headSha: sha,
      headRepositoryId: "42",
      baseRepositoryId: "42",
      authorId: "8",
      state: "open",
      draft: false,
      updatedAt: stamp,
    },
    observedAt: new Date(now - 100).toISOString(),
    collectionsComplete: true,
    workflowRuns: [
      {
        id: "60",
        workflowId: "61",
        checkSuiteId: "62",
        runNumber: 9,
        runAttempt: 2,
        headSha: sha,
        status: "completed",
        conclusion: "success",
        updatedAt: stamp,
        event: "pull_request",
        jobs: [
          {
            id: "70",
            runId: "60",
            runAttempt: 2,
            name: "Test",
            status: "completed",
            conclusion: "success",
            startedAt: stamp,
            completedAt: stamp,
            checkRunUrl: "https://api.github.com/repos/owner/repo/check-runs/80",
          },
        ],
      },
    ],
    checks: [
      {
        id: "80",
        checkSuiteId: "62",
        name: "Test",
        headSha: sha,
        status: "completed",
        conclusion: "success",
        startedAt: stamp,
        completedAt: stamp,
        appId: "81",
        appSlug: "github-actions",
      },
    ],
    reviews: [
      {
        id: "90",
        userId: "9",
        state: "APPROVED",
        commitId: sha,
        submittedAt: stamp,
        bodyDigest: "b".repeat(64),
      },
    ],
    reviewSummaries: [
      {
        id: "91",
        userId: "10",
        userType: "Bot",
        appId: "11",
        updatedAt: stamp,
        createdAt: stamp,
        bodyDigest: "c".repeat(64),
        markerPresent: true,
        markerCount: 1,
        marker: {
          code_review: {
            commit_sha: sha,
            status: "completed",
            has_any_findings: false,
            has_unresolved_findings: false,
          },
        },
      },
    ],
    reviewThreads: [{ id: "THREAD", isResolved: true, isOutdated: false }],
  };
  return { target, policy, snapshot, now };
};
