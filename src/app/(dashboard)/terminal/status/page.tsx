import { redirect } from "next/navigation";
import { hiveWindowHref } from "@/lib/workspaces/general-workspace";

export default async function TerminalStatusPage({
  searchParams,
}: {
  searchParams?: Promise<{ workspaceId?: string }>;
}) {
  const params = await searchParams;
  redirect(hiveWindowHref({ tool: "diagnostics", workspaceId: params?.workspaceId }));
}
