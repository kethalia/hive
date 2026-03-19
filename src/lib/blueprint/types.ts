/**
 * Shared types for the blueprint execution system.
 *
 * A blueprint is a sequence of typed async steps that run inside a workspace.
 * Per R025: "TypeScript functions, not a generic engine."
 */

/** Full context passed through every blueprint step. */
export interface BlueprintContext {
  taskId: string;
  workspaceName: string;
  repoUrl: string;
  prompt: string;
  branchName: string;
  /** Pre-assembled context (files, docs, etc.) for the agent prompt. */
  assembledContext: string;
  /** Scoped rules (e.g. coding standards, repo conventions). */
  scopedRules: string;
  /** Tool names to enable for the agent (e.g. ["bash", "edit", "read"]). Prefixed with --tool= at invocation time. */
  toolFlags: string[];
  /** AI provider identifier (e.g. "anthropic", "openai"). */
  piProvider: string;
  /** Model identifier (e.g. "claude-sonnet-4-20250514"). */
  piModel: string;
}

/** Outcome of a single blueprint step execution. */
export interface StepResult {
  status: "success" | "failure" | "skipped";
  message: string;
  durationMs: number;
}

/** A named blueprint step with an async execute function. */
export interface BlueprintStep {
  name: string;
  execute: (ctx: BlueprintContext) => Promise<StepResult>;
}

/** Aggregate result of running all blueprint steps. */
export interface BlueprintResult {
  success: boolean;
  steps: Array<{ name: string } & StepResult>;
  totalDurationMs: number;
}
