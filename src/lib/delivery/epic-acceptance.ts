import type { AcceptancePlanResult, InheritedAcceptanceCriteria } from "./acceptance-contracts";
import { DeliveryConflict } from "./state";

/** An independently produced mapping binds each trusted owner criterion to a
 * distinct child requirement. Additional child requirements remain mandatory. */
export function bindEpicAcceptance(
  inherited: InheritedAcceptanceCriteria,
  child: AcceptancePlanResult,
) {
  if (
    child.outcome !== "ready" ||
    !child.inheritedMappings ||
    child.inheritedMappings.length !== inherited.requirements.length
  )
    throw new DeliveryConflict("epic_acceptance_mapping_incomplete");
  const used = new Set<string>();
  return inherited.requirements.map((owner) => {
    const entries =
      child.inheritedMappings?.filter((item) => item.ownerCriterionId === owner.id) ?? [];
    if (entries.length !== 1 || used.has(entries[0].childRequirementId))
      throw new DeliveryConflict("epic_acceptance_mapping_incomplete");
    const matches = child.requirements.filter(
      (item) => item.id === entries[0].childRequirementId && item.phase === owner.phase,
    );
    if (matches.length !== 1) throw new DeliveryConflict("epic_acceptance_mapping_incomplete");
    used.add(entries[0].childRequirementId);
    return { ownerCriterionId: owner.id, childRequirementId: matches[0].id };
  });
}
