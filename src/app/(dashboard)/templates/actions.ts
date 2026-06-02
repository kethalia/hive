"use server";

import { revalidatePath } from "next/cache";
import { getRequestSession } from "@/lib/auth/session";
import { compareTemplates, KNOWN_TEMPLATES, type TemplateStatus } from "@/lib/templates/staleness";

/**
 * Fetch staleness status for all known templates.
 * Can be called from server components or client components via server action.
 */
export async function getTemplateStatuses(): Promise<TemplateStatus[]> {
  const session = await getRequestSession();
  if (!session) {
    throw new Error("Not authenticated");
  }
  return compareTemplates([...KNOWN_TEMPLATES], session.user.id);
}

/**
 * Revalidate the /templates page cache.
 * Call after a successful push so the next load shows fresh staleness data.
 */
export async function revalidateTemplates(): Promise<void> {
  revalidatePath("/templates");
}
