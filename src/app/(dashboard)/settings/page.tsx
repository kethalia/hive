import { redirect } from "next/navigation";
import { hiveWindowHref } from "@/lib/workspaces/general-workspace";

export default function SettingsPage() {
  redirect(hiveWindowHref({ tool: "settings" }));
}
