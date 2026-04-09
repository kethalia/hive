/**
 * Types for structured verification reports.
 *
 * A verification report captures the outcome of running deterministic
 * checks against a worker's PR branch — e.g. running tests, starting
 * a web app and screenshotting it, or serving static HTML.
 */

/** Strategy used to verify the output of a task. */
export type VerificationStrategy = "test-suite" | "web-app" | "static-site" | "none";

/** High-level outcome of verification. */
export type VerificationOutcome = "pass" | "fail" | "inconclusive";

/** Structured verification report stored on a task record. */
export interface VerificationReport {
  /** Which verification strategy was selected by the detect step. */
  strategy: VerificationStrategy;
  /** High-level outcome: pass, fail, or inconclusive (e.g. no tests found). */
  outcome: VerificationOutcome;
  /** Combined stdout/stderr from the verification execution. */
  logs: string;
  /** Wall-clock duration of the verification execution in milliseconds. */
  durationMs: number;
  /** ISO 8601 timestamp of when the report was generated. */
  timestamp: string;
}

/**
 * Runtime type guard for VerificationReport.
 * Validates the shape of Prisma's Json? column before rendering.
 */
export function isVerificationReport(value: unknown): value is VerificationReport {
  if (typeof value !== "object" || value === null) return false;
  return (
    "strategy" in value &&
    typeof value.strategy === "string" &&
    "outcome" in value &&
    typeof value.outcome === "string" &&
    "durationMs" in value &&
    typeof value.durationMs === "number" &&
    "timestamp" in value &&
    typeof value.timestamp === "string"
  );
}
