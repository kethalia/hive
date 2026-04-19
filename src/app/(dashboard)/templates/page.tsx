import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { compareTemplates, KNOWN_TEMPLATES } from "@/lib/templates/staleness";
import { TemplatesClient } from "@/components/templates/TemplatesClient";
import { getSession } from "@/lib/auth/session";

export default async function TemplatesPage() {
  const cookieStore = await cookies();
  const session = await getSession(cookieStore);
  if (!session) {
    redirect("/login");
  }

  let initialStatuses = await compareTemplates([...KNOWN_TEMPLATES], session.user.id).catch((err) => {
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
