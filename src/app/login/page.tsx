import { redirect } from "next/navigation";
import { coderLoginError, coderLoginMode, coderLoginStartUrl } from "@/lib/auth/coder-login.server";
import { getRequestSession } from "@/lib/auth/session";
import { CoderOAuthLogin } from "./coder-oauth-login";
import { LoginForm } from "./login-form";

export const dynamic = "force-dynamic";

export default async function LoginPage({
  searchParams,
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await getRequestSession();
  if (session) redirect("/workspaces");
  const mode = coderLoginMode();
  if (mode === "legacy") return <LoginForm />;
  return (
    <CoderOAuthLogin
      startUrl={mode === "oauth" ? coderLoginStartUrl() : null}
      error={coderLoginError(searchParams ? await searchParams : {})}
    />
  );
}
