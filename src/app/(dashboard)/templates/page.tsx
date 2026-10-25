import { redirect } from "next/navigation";
import { hiveWindowHref } from "@/lib/workspaces/general-workspace";
export default function TemplatesPage() {
  redirect(hiveWindowHref({ tool: "templates" }));
}
