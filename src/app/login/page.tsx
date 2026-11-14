import { redirect } from "next/navigation";
import { getRequestSession } from "@/lib/auth/session";
import { CoderOAuthLogin } from "./coder-oauth-login";
import { LoginForm } from "./login-form";

export default async function LoginPage({
  searchParams,
}: {
  searchParams?: Promise<{ error?: string }>;
} = {}) {
  const session = await getRequestSession();
  if (session) redirect("/workspaces");
  if (process.env.HIVE_CODER_OAUTH_ENABLED === "true")
    return <CoderOAuthLogin error={Boolean((await searchParams)?.error)} />;
  return <LoginForm />;
}
