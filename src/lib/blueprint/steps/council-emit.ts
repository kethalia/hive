import type { BlueprintStep, BlueprintContext } from "../types";
import type { ReviewerFinding } from "@/lib/council/types";

/**
 * Create the council-emit step — R033 enforcement gate.
 *
 * Validates the raw JSON string stored on `ctx.councilFindings` by council-review.
 * Enforces strict structural validation: the response must parse as JSON, must have
 * a `findings` array, and every element must conform to ReviewerFinding.
 *
 * Any validation failure returns a structured `{ status: "failure" }` result so the
 * job fails with a clear diagnostic rather than silently surfacing bad data.
 */
export function createCouncilEmitStep(): BlueprintStep {
  return {
    name: "council-emit",
    async execute(ctx: BlueprintContext) {
      const start = Date.now();
      const raw = ctx.councilFindings ?? "";

      // Step 1: JSON parse
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        const preview = raw.slice(0, 200);
        const msg = `Invalid JSON from Claude: ${preview}`;
        console.log(`[blueprint] council-emit: ${msg} (task=${ctx.taskId})`);
        return { status: "failure", message: msg, durationMs: Date.now() - start };
      }

      // Step 2: Top-level shape — must have findings array
      if (
        typeof parsed !== "object" ||
        parsed === null ||
        !("findings" in parsed) ||
        !Array.isArray((parsed as Record<string, unknown>).findings)
      ) {
        const msg = "Findings schema validation failed: missing or non-array 'findings' field";
        console.log(`[blueprint] council-emit: ${msg} (task=${ctx.taskId})`);
        return { status: "failure", message: msg, durationMs: Date.now() - start };
      }

      const findings = (parsed as Record<string, unknown>).findings as unknown[];

      // Step 3: Validate each finding element
      const VALID_SEVERITIES = new Set(["critical", "major", "minor", "nit"]);

      for (let i = 0; i < findings.length; i++) {
        const finding = findings[i];
        if (typeof finding !== "object" || finding === null) {
          const msg = `Findings schema validation failed: finding[${i}] is not an object`;
          console.log(`[blueprint] council-emit: ${msg} (task=${ctx.taskId})`);
          return { status: "failure", message: msg, durationMs: Date.now() - start };
        }

        const f = finding as Record<string, unknown>;
        const validationError = validateFinding(f, i, VALID_SEVERITIES);
        if (validationError) {
          const msg = `Findings schema validation failed: ${validationError}`;
          console.log(`[blueprint] council-emit: ${msg} (task=${ctx.taskId})`);
          return { status: "failure", message: msg, durationMs: Date.now() - start };
        }
      }

      // All findings valid — emit
      const validFindings = findings as ReviewerFinding[];
      const msg = `Emitted ${validFindings.length} finding(s)`;
      console.log(`[blueprint] council-emit: ${msg} (task=${ctx.taskId})`);
      return {
        status: "success",
        message: JSON.stringify(validFindings),
        durationMs: Date.now() - start,
      };
    },
  };
}

/**
 * Validate a single finding object against the ReviewerFinding schema.
 * Returns an error string if invalid, or null if valid.
 */
function validateFinding(
  f: Record<string, unknown>,
  index: number,
  validSeverities: Set<string>,
): string | null {
  if (typeof f.file !== "string") {
    return `finding[${index}].file must be a string`;
  }
  if (typeof f.startLine !== "number") {
    return `finding[${index}].startLine must be a number`;
  }
  if (typeof f.severity !== "string" || !validSeverities.has(f.severity)) {
    return `finding[${index}].severity must be one of critical/major/minor/nit`;
  }
  if (typeof f.issue !== "string") {
    return `finding[${index}].issue must be a string`;
  }
  if (typeof f.fix !== "string") {
    return `finding[${index}].fix must be a string`;
  }
  if (typeof f.reasoning !== "string") {
    return `finding[${index}].reasoning must be a string`;
  }
  return null;
}
