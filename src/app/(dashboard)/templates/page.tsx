import { compareTemplates, KNOWN_TEMPLATES } from "@/lib/templates/staleness";
import { TemplatesClient } from "@/components/templates/TemplatesClient";

/**
 * /templates — Template management dashboard.
 *
 * Fetches initial staleness data server-side and hands it to the
 * client component which handles push actions and live terminal output.
 */
export default async function TemplatesPage() {
  let initialStatuses = await compareTemplates([...KNOWN_TEMPLATES]).catch((err) => {
    console.error(`[templates/page] Failed to load initial statuses: ${err instanceof Error ? err.message : String(err)}`);
    return KNOWN_TEMPLATES.map((name) => ({
      name,
      stale: false,
      lastPushed: null,
      activeVersionId: null,
      localHash: "",
      remoteHash: null,
    }));
  });

  return <TemplatesClient initialStatuses={initialStatuses} />;
}
