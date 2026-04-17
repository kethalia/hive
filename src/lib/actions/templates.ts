"use server";

import { actionClient } from "@/lib/safe-action";
import { compareTemplates, KNOWN_TEMPLATES } from "@/lib/templates/staleness";

export const listTemplateStatusesAction = actionClient.action(async () => {
  return compareTemplates([...KNOWN_TEMPLATES]);
});
