import { describe, expect, it, vi, beforeEach } from "vitest";
import type { Job } from "bullmq";
import type { CouncilAggregatorJobData } from "../../../lib/queue/council-queues.js";
import type { ReviewerFinding } from "../../../lib/council/types.js";

// ── Module mocks ────────────────────────────────────────────────────────────

vi.mock("../../../lib/db/index.js", () => ({
  getDb: vi.fn(),
}));

vi.mock("../../../lib/council/comment.js", () => ({
  postPRComment: vi.fn(),
}));

// ── Imports (after mocks) ───────────────────────────────────────────────────

import { createCouncilAggregatorProcessor } from "../../../lib/council/aggregator-processor.js";
import { getDb } from "../../../lib/db/index.js";
import { postPRComment } from "../../../lib/council/comment.js";

// ── Test helpers ────────────────────────────────────────────────────────────

function finding(
  file: string,
  startLine: number,
  overrides: Partial<ReviewerFinding> = {},
): ReviewerFinding {
  return {
    file,
    startLine,
    severity: "major",
    issue: "Test issue",
    fix: "Test fix",
    reasoning: "Test reasoning",
    ...overrides,
  };
}

type MockPrisma = {
  task: {
    update: ReturnType<typeof vi.fn>;
  };
};

function makeMockDb(): MockPrisma {
  return {
    task: {
      update: vi.fn().mockResolvedValue({}),
    },
  };
}

function makeJob(
  data: CouncilAggregatorJobData,
  childrenValues: Record<string, unknown>,
): Partial<Job<CouncilAggregatorJobData>> {
  return {
    id: "job-test-1",
    data,
    getChildrenValues: vi.fn().mockResolvedValue(childrenValues),
  };
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe("createCouncilAggregatorProcessor", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns outcome=complete when all reviewers succeed", async () => {
    const db = makeMockDb();
    vi.mocked(getDb).mockReturnValue(db as never);
    vi.mocked(postPRComment).mockResolvedValue(
      "https://github.com/owner/repo/pull/1#issuecomment-100",
    );

    const f1 = finding("src/a.ts", 10);
    const f2 = finding("src/b.ts", 20);
    // Two reviewers both flag src/a.ts:10 → consensus; f2 only flagged by reviewer 1
    const childrenValues: Record<string, unknown> = {
      "queue:job1": [f1, f2],
      "queue:job2": [f1],
      "queue:job3": [f1],
    };

    const job = makeJob(
      { taskId: "task-aaa", councilSize: 3, prUrl: "https://github.com/owner/repo/pull/1" },
      childrenValues,
    );

    const processor = createCouncilAggregatorProcessor();
    const report = await processor(job as Job<CouncilAggregatorJobData>);

    expect(report.outcome).toBe("complete");
    expect(report.councilSize).toBe(3);
    expect(report.reviewersCompleted).toBe(3);
    // src/a.ts:10 flagged 3x → consensus
    const consensus = report.consensusItems.find(
      (f) => f.file === "src/a.ts" && f.startLine === 10,
    );
    expect(consensus).toBeDefined();
    expect(consensus!.agreementCount).toBe(3);
    expect(consensus!.isConsensus).toBe(true);
  });

  it("returns outcome=partial when some reviewers fail (null entries)", async () => {
    const db = makeMockDb();
    vi.mocked(getDb).mockReturnValue(db as never);
    vi.mocked(postPRComment).mockResolvedValue(null);

    const f1 = finding("src/a.ts", 10);
    const childrenValues: Record<string, unknown> = {
      "queue:job1": [f1],
      "queue:job2": null, // reviewer failed
      "queue:job3": [f1],
    };

    const job = makeJob(
      { taskId: "task-bbb", councilSize: 3, prUrl: "https://github.com/owner/repo/pull/2" },
      childrenValues,
    );

    const processor = createCouncilAggregatorProcessor();
    const report = await processor(job as Job<CouncilAggregatorJobData>);

    expect(report.outcome).toBe("partial");
    expect(report.reviewersCompleted).toBe(2);
  });

  it("returns outcome=inconclusive when all reviewers fail", async () => {
    const db = makeMockDb();
    vi.mocked(getDb).mockReturnValue(db as never);
    vi.mocked(postPRComment).mockResolvedValue(null);

    const childrenValues: Record<string, unknown> = {
      "queue:job1": null,
      "queue:job2": undefined,
      "queue:job3": "not-an-array", // non-array values also treated as failed
    };

    const job = makeJob(
      { taskId: "task-ccc", councilSize: 3, prUrl: "https://github.com/owner/repo/pull/3" },
      childrenValues,
    );

    const processor = createCouncilAggregatorProcessor();
    const report = await processor(job as Job<CouncilAggregatorJobData>);

    expect(report.outcome).toBe("inconclusive");
    expect(report.reviewersCompleted).toBe(0);
    expect(report.findings).toHaveLength(0);
    expect(report.consensusItems).toHaveLength(0);
  });

  it("persists CouncilReport to DB with the correct shape", async () => {
    const db = makeMockDb();
    vi.mocked(getDb).mockReturnValue(db as never);
    vi.mocked(postPRComment).mockResolvedValue(
      "https://github.com/owner/repo/pull/4#issuecomment-200",
    );

    const taskId = "task-ddd";
    const f1 = finding("src/x.ts", 5);
    const childrenValues: Record<string, unknown> = {
      "queue:job1": [f1],
      "queue:job2": [f1],
    };

    const job = makeJob(
      { taskId, councilSize: 2, prUrl: "https://github.com/owner/repo/pull/4" },
      childrenValues,
    );

    const processor = createCouncilAggregatorProcessor();
    const report = await processor(job as Job<CouncilAggregatorJobData>);

    // DB update should have been called once with the task id and full report
    expect(db.task.update).toHaveBeenCalledOnce();
    const updateCall = db.task.update.mock.calls[0][0] as {
      where: { id: string };
      data: { councilReport: unknown };
    };
    expect(updateCall.where.id).toBe(taskId);

    const persisted = updateCall.data.councilReport as typeof report;
    expect(persisted.outcome).toBe("complete");
    expect(persisted.councilSize).toBe(2);
    expect(persisted.reviewersCompleted).toBe(2);
    expect(Array.isArray(persisted.findings)).toBe(true);
    expect(Array.isArray(persisted.consensusItems)).toBe(true);
    expect(typeof persisted.durationMs).toBe("number");
    expect(typeof persisted.timestamp).toBe("string");
  });

  it("calls postPRComment with a non-empty formatted body", async () => {
    const db = makeMockDb();
    vi.mocked(getDb).mockReturnValue(db as never);
    vi.mocked(postPRComment).mockResolvedValue(null);

    const f1 = finding("src/y.ts", 7, { severity: "critical" });
    const childrenValues: Record<string, unknown> = {
      "queue:job1": [f1],
      "queue:job2": [f1],
    };

    const prUrl = "https://github.com/owner/repo/pull/5";
    const job = makeJob(
      { taskId: "task-eee", councilSize: 2, prUrl },
      childrenValues,
    );

    const processor = createCouncilAggregatorProcessor();
    await processor(job as Job<CouncilAggregatorJobData>);

    expect(postPRComment).toHaveBeenCalledOnce();
    const [calledUrl, calledBody] = vi.mocked(postPRComment).mock.calls[0] as [string, string];
    expect(calledUrl).toBe(prUrl);
    expect(typeof calledBody).toBe("string");
    expect(calledBody.length).toBeGreaterThan(0);
    // Body should include the council review header
    expect(calledBody).toContain("Council Review");
  });

  it("sets postedCommentUrl=null in report when postPRComment returns null", async () => {
    const db = makeMockDb();
    vi.mocked(getDb).mockReturnValue(db as never);
    vi.mocked(postPRComment).mockResolvedValue(null);

    const childrenValues: Record<string, unknown> = {
      "queue:job1": [],
    };

    const job = makeJob(
      { taskId: "task-fff", councilSize: 1, prUrl: "https://github.com/owner/repo/pull/6" },
      childrenValues,
    );

    const processor = createCouncilAggregatorProcessor();
    const report = await processor(job as Job<CouncilAggregatorJobData>);

    expect(report.postedCommentUrl).toBeNull();
    // Report should still be persisted even without a comment URL
    expect(db.task.update).toHaveBeenCalledOnce();
  });

  it("re-throws when DB update fails", async () => {
    const db = makeMockDb();
    db.task.update.mockRejectedValue(new Error("DB connection lost"));
    vi.mocked(getDb).mockReturnValue(db as never);
    vi.mocked(postPRComment).mockResolvedValue(null);

    const job = makeJob(
      { taskId: "task-ggg", councilSize: 1, prUrl: "https://github.com/owner/repo/pull/7" },
      { "queue:job1": [] },
    );

    const processor = createCouncilAggregatorProcessor();
    await expect(processor(job as Job<CouncilAggregatorJobData>)).rejects.toThrow(
      "DB connection lost",
    );
  });
});
