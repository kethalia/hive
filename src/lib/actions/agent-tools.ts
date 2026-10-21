"use server";

import { z } from "zod";
import {
  agentResumeResultSchema,
  agentSessionKeySchema,
  agentToolsSnapshotSchema,
} from "@/lib/agents/types";
import { runWorkspaceAgentOperation } from "@/lib/agents/workspace";
import { authActionClient } from "@/lib/safe-action";

const workspaceInput = z.object({ workspaceId: z.string().uuid() }).strict();

export const inspectAgentToolsAction = authActionClient
  .inputSchema(workspaceInput)
  .action(async ({ ctx, parsedInput }) =>
    agentToolsSnapshotSchema.parse(
      await runWorkspaceAgentOperation(ctx.user, parsedInput.workspaceId, "inspect"),
    ),
  );

export const configureAgentToolsAction = authActionClient
  .inputSchema(
    workspaceInput.extend({
      operation: z.enum(["install", "disable", "configure-coder"]),
    }),
  )
  .action(async ({ ctx, parsedInput }) => {
    const result = await runWorkspaceAgentOperation(
      ctx.user,
      parsedInput.workspaceId,
      parsedInput.operation,
    );
    return z.object({ message: z.string().max(200) }).parse(result);
  });

export const resumeAgentSessionAction = authActionClient
  .inputSchema(
    workspaceInput.extend({
      key: agentSessionKeySchema,
    }),
  )
  .action(async ({ ctx, parsedInput }) =>
    agentResumeResultSchema.parse(
      await runWorkspaceAgentOperation(
        ctx.user,
        parsedInput.workspaceId,
        "resume",
        parsedInput.key,
      ),
    ),
  );
