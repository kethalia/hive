import type { VerificationReport, VerificationStrategy, VerificationOutcome } from "@/lib/verification/types";
import type { BlueprintStep } from "../types";

/**
 * Create the verify-report step.
 *
 * Assembles a structured VerificationReport from the intermediate
 * data stored on ctx by the detect and execute steps, then
 * serializes it to ctx.verificationReport for persistence.
 */
export function createVerifyReportStep(): BlueprintStep {
  return {
    name: "verify-report",
    async execute(ctx) {
      const start = Date.now();

      const strategy = (ctx.verificationStrategy ?? "none") as VerificationStrategy;

      // Parse intermediate data from execute step
      let outcome: VerificationOutcome = "inconclusive";
      let logs = "";

      let executionDurationMs: number | undefined;

      if (ctx.verificationReport) {
        try {
          const intermediate = JSON.parse(ctx.verificationReport);
          outcome = intermediate.outcome ?? "inconclusive";
          logs = intermediate.logs ?? "";
          if (typeof intermediate.durationMs === "number") {
            executionDurationMs = intermediate.durationMs;
          }
        } catch {
          // If parsing fails, report inconclusive with a note
          logs = "Failed to parse intermediate verification data";
        }
      }

      const report: VerificationReport = {
        strategy,
        outcome,
        logs,
        // Use actual execution duration from verify-execute, fall back to report step time
        durationMs: executionDurationMs ?? (Date.now() - start),
        timestamp: new Date().toISOString(),
      };

      ctx.verificationReport = JSON.stringify(report);

      const msg = `Report generated: strategy=${strategy}, outcome=${outcome}`;
      console.log(`[blueprint] verify-report: ${msg} (task=${ctx.taskId})`);
      return { status: "success", message: msg, durationMs: Date.now() - start };
    },
  };
}
