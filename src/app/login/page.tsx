import { redirect } from "next/navigation";
import { HiveMark } from "@/components/hive-logo";
import { getRequestSession } from "@/lib/auth/session";
import { CoderOAuthLogin } from "./coder-oauth-login";
import { LoginForm } from "./login-form";
import { LoginHomeLink } from "./login-home-link";

export default async function LoginPage({
  searchParams,
}: {
  searchParams?: Promise<{ error?: string }>;
}) {
  const session = await getRequestSession();
  if (session) redirect("/workspaces");
  const coderOAuthEnabled = process.env.HIVE_CODER_OAUTH_ENABLED === "true";
  return (
    <section aria-labelledby="hive-sign-in" className="space-y-6">
      <header className="flex flex-col items-center gap-3 text-center">
        <HiveMark className="size-11 rounded-md" />
        <h1 id="hive-sign-in" className="text-xl font-semibold">
          Sign in to Hive
        </h1>
        <p className="text-sm text-muted-foreground">
          Use your Coder account to open your workspaces.
        </p>
      </header>
      {coderOAuthEnabled ? (
        <CoderOAuthLogin error={Boolean((await searchParams)?.error)} />
      ) : (
        <LoginForm />
      )}
      <div className="text-center">
        <LoginHomeLink />
      </div>
    </section>
  );
}
