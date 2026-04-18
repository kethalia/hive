import { describe, expect, it, vi, beforeEach } from "vitest";
import type { Job } from "bullmq";
import type { CouncilReviewerJobData } from "../../../lib/queue/council-queues.js";
import type { ReviewerFinding } from "../../../lib/council/types.js";
import type { CoderClient } from "../../../lib/coder/client.js";

// ── Module mocks ────────────────────────────────────────────────────────────

vi.mock("../../../lib/blueprint/runner.js", () => ({
  runBlueprint: vi.fn(),
}));

vi.mock("../../../lib/workspace/cleanup.js", () => ({
  cleanupWorkspace: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../../lib/db/index.js", () => ({
  getDb: vi.fn().mockReturnValue({}),
}));

vi.mock("../../../lib/coder/user-client.js", () => ({
  getCoderClientForUser: vi.fn(),
}));

// ── Imports (after mocks) ───────────────────────────────────────────────────

import { createCouncilReviewerProcessor } from "../../../lib/council/reviewer-processor.js";
import { runBlueprint } from "../../../lib/blueprint/runner.js";
import { cleanupWorkspace } from "../../../lib/workspace/cleanup.js";
import { getCoderClientForUser } from "../../../lib/coder/user-client.js";

const mockedGetCoderClientForUser = vi.mocked(getCoderClientForUser);

// ── Helpers ─────────────────────────────────────────────────────────────────

function mockCoderClient(overrides: Partial<{
  createWorkspace: ReturnType<typeof vi.fn>;
  waitForBuild: ReturnType<typeof vi.fn>;
  getWorkspaceAgentName: ReturnType<typeof vi.fn>;
}> = {}): CoderClient {
  return {
    createWorkspace: vi.fn().mockResolvedValue({ id: "ws-abc123", name: "hive-council-task001-0" }),
    waitForBuild: vi.fn().mockResolvedValue({ id: "ws-abc123", latest_build: { status: "running" } }),
    getWorkspaceAgentName: vi.fn().mockResolvedValue("hive-council-task001-0.dev"),
    ...overrides,
  } as unknown as CoderClient;
}

function makeJob(
  overrides: Partial<CouncilReviewerJobData> = {},
): Partial<Job<CouncilReviewerJobData>> {
  return {
    id: "reviewer-job-1",
    data: {
      taskId: "task001-aabb",
      reviewerIndex: 0,
      prUrl: "https://github.com/owner/repo/pull/42",
      repoUrl: "https://github.com/owner/repo",
      branchName: "feature/my-branch",
      userId: "user-123",
      ...overrides,
    },
  };
}

const SAMPLE_FINDINGS: ReviewerFinding[] = [
  {
    file: "src/foo.ts",
    startLine: 12,
    severity: "major",
    issue: "Memory leak",
    fix: "Clean up subscription",
    reasoning: "useEffect cleanup missing",
  },
];

function makeSuccessBlueprint(findings: ReviewerFinding[] = SAMPLE_FINDINGS) {
  return {
    success: true,
    totalDurationMs: 100,
    steps: [
      { name: "council-clone", status: "success" as const, message: "cloned", durationMs: 10 },
      { name: "council-diff", status: "success" as const, message: "diff captured", durationMs: 10 },
      { name: "council-review", status: "success" as const, message: "review done", durationMs: 50 },
      {
        name: "council-emit",
        status: "success" as const,
        message: JSON.stringify(findings),
        durationMs: 10,
      },
    ],
  };
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe("createCouncilReviewerProcessor", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.CODER_COUNCIL_TEMPLATE_ID = "tmpl-council-001";
  });

  it("returns parsed ReviewerFinding[] on successful blueprint run", async () => {
    vi.mocked(runBlueprint).mockResolvedValue(makeSuccessBlueprint());
    const coderClient = mockCoderClient();
    mockedGetCoderClientForUser.mockResolvedValue(coderClient);
    const processor = createCouncilReviewerProcessor();
    const job = makeJob();

    const result = await processor(job as Job<CouncilReviewerJobData>);

    expect(result).toHaveLength(1);
    expect(result[0].file).toBe("src/foo.ts");
    expect(result[0].startLine).toBe(12);
    expect(result[0].severity).toBe("major");
  });

  it("creates workspace with correct templateId and workspaceName", async () => {
    vi.mocked(runBlueprint).mockResolvedValue(makeSuccessBlueprint());
    const coderClient = mockCoderClient();
    mockedGetCoderClientForUser.mockResolvedValue(coderClient);
    const processor = createCouncilReviewerProcessor();

    await processor(makeJob() as Job<CouncilReviewerJobData>);

    expect(coderClient.createWorkspace).toHaveBeenCalledWith(
      "tmpl-council-001",
      "hive-council-task001--0",
      {
        task_id: "task001-aabb",
        repo_url: "https://github.com/owner/repo",
        branch_name: "feature/my-branch",
      },
    );
  });

  it("throws when blueprint fails, causing BullMQ to mark job failed", async () => {
    vi.mocked(runBlueprint).mockResolvedValue({
      success: false,
      totalDurationMs: 50,
      steps: [
        {
          name: "council-clone",
          status: "failure",
          message: "git clone failed",
          durationMs: 50,
        },
      ],
    });
    const coderClient = mockCoderClient();
    mockedGetCoderClientForUser.mockResolvedValue(coderClient);
    const processor = createCouncilReviewerProcessor();

    await expect(
      processor(makeJob() as Job<CouncilReviewerJobData>),
    ).rejects.toThrow("Blueprint failed");
  });

  it("runs workspace cleanup even when blueprint fails (finally block)", async () => {
    vi.mocked(runBlueprint).mockResolvedValue({
      success: false,
      totalDurationMs: 20,
      steps: [
        { name: "council-clone", status: "failure", message: "auth error", durationMs: 20 },
      ],
    });
    const coderClient = mockCoderClient();
    mockedGetCoderClientForUser.mockResolvedValue(coderClient);
    const processor = createCouncilReviewerProcessor();

    await expect(
      processor(makeJob() as Job<CouncilReviewerJobData>),
    ).rejects.toThrow();

    expect(cleanupWorkspace).toHaveBeenCalledOnce();
    expect(cleanupWorkspace).toHaveBeenCalledWith(
      coderClient,
      "ws-abc123",
      expect.any(Number),
      expect.anything(),
    );
  });

  it("runs cleanup even when createWorkspace throws before workspace is created", async () => {
    const coderClient = mockCoderClient({
      createWorkspace: vi.fn().mockRejectedValue(new Error("quota exceeded")),
    });
    mockedGetCoderClientForUser.mockResolvedValue(coderClient);
    const processor = createCouncilReviewerProcessor();

    await expect(
      processor(makeJob() as Job<CouncilReviewerJobData>),
    ).rejects.toThrow("quota exceeded");

    expect(cleanupWorkspace).not.toHaveBeenCalled();
  });

  it("throws when council-emit step is missing from successful blueprint", async () => {
    vi.mocked(runBlueprint).mockResolvedValue({
      success: true,
      totalDurationMs: 80,
      steps: [
        { name: "council-clone", status: "success", message: "ok", durationMs: 10 },
        { name: "council-diff", status: "success", message: "ok", durationMs: 10 },
        { name: "council-review", status: "success", message: "ok", durationMs: 50 },
      ],
    });
    const coderClient = mockCoderClient();
    mockedGetCoderClientForUser.mockResolvedValue(coderClient);
    const processor = createCouncilReviewerProcessor();

    await expect(
      processor(makeJob() as Job<CouncilReviewerJobData>),
    ).rejects.toThrow("council-emit step missing");
  });

  it("throws when council-emit message is not valid JSON", async () => {
    vi.mocked(runBlueprint).mockResolvedValue({
      success: true,
      totalDurationMs: 80,
      steps: [
        { name: "council-clone", status: "success", message: "ok", durationMs: 10 },
        { name: "council-diff", status: "success", message: "ok", durationMs: 10 },
        { name: "council-review", status: "success", message: "ok", durationMs: 50 },
        {
          name: "council-emit",
          status: "success",
          message: "not-json!!!",
          durationMs: 5,
        },
      ],
    });
    const coderClient = mockCoderClient();
    mockedGetCoderClientForUser.mockResolvedValue(coderClient);
    const processor = createCouncilReviewerProcessor();

    await expect(
      processor(makeJob() as Job<CouncilReviewerJobData>),
    ).rejects.toThrow("not valid JSON");
  });

  it("uses reviewerIndex=1 for second reviewer workspace name", async () => {
    vi.mocked(runBlueprint).mockResolvedValue(makeSuccessBlueprint());
    const coderClient = mockCoderClient();
    mockedGetCoderClientForUser.mockResolvedValue(coderClient);
    const processor = createCouncilReviewerProcessor();

    await processor(makeJob({ reviewerIndex: 1 }) as Job<CouncilReviewerJobData>);

    const [, workspaceName] = vi.mocked(coderClient.createWorkspace).mock.calls[0] as [string, string];
    expect(workspaceName).toBe("hive-council-task001--1");
  });
});
