import { redirect } from "next/navigation";
import { getRequestSession } from "@/lib/auth/session";
import { LoginForm } from "./login-form";

export default async function LoginPage() {
  const session = await getRequestSession();
  if (session) redirect("/workspaces");
  return <LoginForm />;
}
