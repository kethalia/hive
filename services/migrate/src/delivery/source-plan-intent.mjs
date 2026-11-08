import { requireValue, validatePlan } from "./contracts.mjs";

/** Unknown build bytes are omitted from owner intent, never filled into a grant. */
export function sourcePlanIntent(plan) {
  const { oldAppDigest: _old, newAppDigest: _new, ...intent } = validatePlan(plan);
  return intent;
}
export function validateSourcePlanIntent(raw) {
  requireValue(
    raw && typeof raw === "object" && !("oldAppDigest" in raw) && !("newAppDigest" in raw),
    "migration_source_intent_invalid",
  );
  // Use the existing strict SQL validator; discard its private validation-only sentinels.
  return sourcePlanIntent({ ...raw, oldAppDigest: "0".repeat(64), newAppDigest: "0".repeat(64) });
}
