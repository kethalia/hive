/**
 * BullMQ processor for council reviewer jobs.
 *
 * Creates a Coder workspace, runs the council-reviewer blueprint, parses
 * ReviewerFinding[] from the council-emit step's message field, and cleans
 * up the workspace in a finally block (D008 pattern).
 *
 * Log prefix: [council-reviewer]
 */

import type { Job } from "bullmq";
import type { CoderClient } from "@/lib/coder/client";
import type { BlueprintContext } from "@/lib/blueprint/types";
import type { ReviewerFinding } from "@/lib/council/types";
import type { CouncilReviewerJobData } from "@/lib/queue/council-queues";
import { createCouncilReviewerBlueprint } from "@/lib/blueprint/council-reviewer";
import { runBlueprint } from "@/lib/blueprint/runner";
import { cleanupWorkspace } from "@/lib/workspace/cleanup";
import { councilWorkspaceName } from "@/lib/workspace/naming";
import { getDb } from "@/lib/db";
import {
  DEFAULT_CLEANUP_GRACE_MS,
  DEFAULT_PI_MODEL,
  DEFAULT_PI_PROVIDER,
} from "@/lib/constants";

/**
 * Returns a BullMQ processor function for council reviewer jobs.
 *
 * @param coderClient - Authenticated Coder API client
 */
export function createCouncilReviewerProcessor(
  coderClient: CoderClient,
): (job: Job<CouncilReviewerJobData>) => Promise<ReviewerFinding[]> {
  return async (job: Job<CouncilReviewerJobData>): Promise<ReviewerFinding[]> => {
    const { taskId, reviewerIndex, repoUrl, branchName } = job.data;
    const councilTemplateId = process.env.CODER_COUNCIL_TEMPLATE_ID ?? "";

    console.log(
      `[council-reviewer] job=${job.id} taskId=${taskId} reviewerIndex=${reviewerIndex} start`,
    );

    const workspaceName = councilWorkspaceName(taskId, reviewerIndex);
    let workspaceId: string | null = null;

    try {
      // 1. Create workspace
      const workspace = await coderClient.createWorkspace(
        councilTemplateId,
        workspaceName,
        {
          task_id: taskId,
          repo_url: repoUrl,
          branch_name: branchName,
        },
      );
      workspaceId = workspace.id;

      console.log(
        `[council-reviewer] job=${job.id} workspaceId=${workspaceId} created`,
      );

      // 2. Wait for the build to become ready
      await coderClient.waitForBuild(workspaceId, "running");

      // 3. Resolve agent SSH target
      const agentName = await coderClient.getWorkspaceAgentName(workspaceId);

      // 4. Build BlueprintContext for council reviewer
      const ctx: BlueprintContext = {
        taskId,
        workspaceName: agentName,
        repoUrl,
        branchName,
        prompt: "", // council-reviewer blueprint is self-contained
        assembledContext: "",
        scopedRules: "",
        toolFlags: [],
        piProvider: DEFAULT_PI_PROVIDER,
        piModel: DEFAULT_PI_MODEL,
      };

      // 5. Run the blueprint
      const steps = createCouncilReviewerBlueprint();
      const result = await runBlueprint(steps, ctx);

      if (!result.success) {
        const failedStep = result.steps.find((s) => s.status === "failure");
        const reason = failedStep?.message ?? "unknown";
        throw new Error(
          `[council-reviewer] Blueprint failed at step "${failedStep?.name ?? "unknown"}": ${reason}`,
        );
      }

      // 6. Extract findings from the council-emit step
      const emitStep = result.steps.find((s) => s.name === "council-emit" && s.status === "success");
      if (!emitStep) {
        throw new Error(
          `[council-reviewer] council-emit step missing or did not succeed`,
        );
      }

      let findings: ReviewerFinding[];
      try {
        findings = JSON.parse(emitStep.message) as ReviewerFinding[];
      } catch {
        throw new Error(
          `[council-reviewer] council-emit message was not valid JSON: ${emitStep.message.slice(0, 200)}`,
        );
      }

      console.log(
        `[council-reviewer] job=${job.id} taskId=${taskId} reviewerIndex=${reviewerIndex} findings=${findings.length}`,
      );

      return findings;
    } finally {
      // D008: cleanup always runs, errors are swallowed
      if (workspaceId) {
        void cleanupWorkspace(coderClient, workspaceId, DEFAULT_CLEANUP_GRACE_MS, getDb());
      }
    }
  };
}
