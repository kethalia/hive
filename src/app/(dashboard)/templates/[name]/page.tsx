import { notFound } from "next/navigation";
import { compareTemplates, KNOWN_TEMPLATES } from "@/lib/templates/staleness";
import { TemplateDetailClient } from "@/components/templates/TemplateDetailClient";

interface Props {
  params: Promise<{ name: string }>;
}

export default async function TemplateDetailPage({ params }: Props) {
  const { name } = await params;

  if (!KNOWN_TEMPLATES.includes(name as (typeof KNOWN_TEMPLATES)[number])) {
    notFound();
  }

  const [status] = await compareTemplates([name]).catch((err) => {
    console.error(
      `[templates/${name}] Failed to load status: ${err instanceof Error ? err.message : String(err)}`
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
