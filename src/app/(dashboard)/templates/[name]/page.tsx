import { redirect } from "next/navigation";
import { hiveWindowHref } from "@/lib/workspaces/general-workspace";
export default async function TemplatePage({ params }: { params: Promise<{ name: string }> }) {
  const { name } = await params;
  redirect(hiveWindowHref({ tool: "templates", template: name }));
}
