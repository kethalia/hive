import { redirect } from "next/navigation";

export default function NotificationsPage() {
  redirect("/workspaces?panel=settings#notifications");
}
