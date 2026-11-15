import { notFound } from "next/navigation";
import { validCoderOAuthPopupAttempt } from "@/lib/auth/coder-oauth-popup";
import { getRequestSession } from "@/lib/auth/session";
import { CoderOAuthComplete } from "./result";

export default async function CoderOAuthCompletePage({
  searchParams,
}: {
  searchParams: Promise<{ attempt?: string | string[]; error?: string | string[] }>;
}) {
  if (process.env.HIVE_CODER_OAUTH_ENABLED !== "true") notFound();
  const params = await searchParams;
  const attempt = validCoderOAuthPopupAttempt(params.attempt) ? params.attempt : null;
  const session = attempt && params.error === undefined ? await getRequestSession() : null;
  return <CoderOAuthComplete attempt={attempt} success={Boolean(session)} />;
}
