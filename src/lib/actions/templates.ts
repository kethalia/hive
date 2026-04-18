"use server";

import { authActionClient } from "@/lib/safe-action";
import { compareTemplates, KNOWN_TEMPLATES } from "@/lib/templates/staleness";

export const listTemplateStatusesAction = authActionClient.action(async ({ ctx }) => {
  return compareTemplates([...KNOWN_TEMPLATES], ctx.user.id);
});
