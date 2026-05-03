import { createCouncilCloneStep } from "./steps/council-clone";
import { createCouncilDiffStep } from "./steps/council-diff";
import { createCouncilEmitStep } from "./steps/council-emit";
import { createCouncilReviewStep } from "./steps/council-review";
import type { BlueprintStep } from "./types";

/**
 * Create the council reviewer blueprint.
 *
 * Returns the ordered sequence of steps that constitute a full code review run:
 * 1. council-clone  — clone the PR branch into the reviewer workspace
 * 2. council-diff   — capture the diff against origin/main
 * 3. council-review — invoke Claude to produce structured JSON findings
 * 4. council-emit   — validate and emit the findings (R033 enforcement gate)
 */
export function createCouncilReviewerBlueprint(): BlueprintStep[] {
  return [
    createCouncilCloneStep(),
    createCouncilDiffStep(),
    createCouncilReviewStep(),
    createCouncilEmitStep(),
  ];
}
