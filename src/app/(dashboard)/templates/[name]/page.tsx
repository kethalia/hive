import { cookies } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { TemplateDetailClient } from "@/components/templates/TemplateDetailClient";
import { getSession } from "@/lib/auth/session";
import { compareTemplates, KNOWN_TEMPLATES } from "@/lib/templates/staleness";

interface Props {
  params: Promise<{ name: string }>;
}

export default async function TemplateDetailPage({ params }: Props) {
  const { name } = await params;
  const cookieStore = await cookies();
  const session = await getSession(cookieStore);
  if (!session) {
    redirect("/login");
  }

  if (!KNOWN_TEMPLATES.includes(name as (typeof KNOWN_TEMPLATES)[number])) {
    notFound();
  }

  const [status] = await compareTemplates([name], session.user.id).catch((err) => {
    console.error(
      `[templates/${name}] Failed to load status: ${err instanceof Error ? err.message : String(err)}`,
    );
    return [
      {
        name,
        stale: false,
        lastPushed: null,
        activeVersionId: null,
        localHash: "",
        remoteHash: null,
      },
    ];
  });

  return <TemplateDetailClient status={status} />;
}
