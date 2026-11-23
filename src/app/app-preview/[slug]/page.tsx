import { getHivePublicOrigin } from "@hive/auth/hive-origin";
import { notFound, redirect } from "next/navigation";
import { AppPreviewViewer, ProductionLink } from "@/components/app-preview-viewer";
import { readAppPreviewCandidates } from "@/lib/app-preview-catalog.server";
import { appPreviewOrigin, hiveProductionOrigin } from "@/lib/app-preview-origin.mjs";
import { getRequestSession } from "@/lib/auth/session";

export const dynamic = "force-dynamic";

export default async function AppPreviewPage({ params }: { params: Promise<{ slug: string }> }) {
  if (
    getHivePublicOrigin() !== hiveProductionOrigin ||
    process.env.HIVE_NATIVE_MODE !== "production"
  )
    notFound();
  if (!(await getRequestSession())) redirect("/login");

  const { slug } = await params;
  const origin = appPreviewOrigin(slug);
  const previews = origin ? await readAppPreviewCandidates().catch(() => null) : null;
  const preview = previews?.find((entry) => entry.slug === slug);
  if (!origin || !preview) {
    return (
      <main id="main-content" className="grid min-h-dvh place-content-center gap-4 p-6 text-center">
        <p role="status">This preview is unavailable.</p>
        <ProductionLink />
      </main>
    );
  }
  return <AppPreviewViewer preview={preview} />;
}
