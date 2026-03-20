import type { BlueprintStep } from "./types";
import { createVerifyCloneStep } from "./steps/verify-clone";
import { createVerifyDetectStep } from "./steps/verify-detect";
import { createVerifyExecuteStep } from "./steps/verify-execute";
import { createVerifyReportStep } from "./steps/verify-report";

/**
 * Create the verifier blueprint — a sequence of steps that clone a
 * PR branch, detect the output type, execute verification, and
 * generate a structured report.
 */
export function createVerifierBlueprint(): BlueprintStep[] {
  return [
    createVerifyCloneStep(),
    createVerifyDetectStep(),
    createVerifyExecuteStep(),
    createVerifyReportStep(),
  ];
}
