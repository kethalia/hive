import { headers } from "next/headers";
import { sessionCookieDomainsToClear } from "@/lib/auth/session-cookie";
import type { CoderClient } from "@/lib/coder/client";
import { assertWorkspaceAppIsolated } from "@/lib/security/workspace-app-isolation";

export interface WorkspaceAppIsolationContext {
  hiveHostname: string;
  cookieDomains: string[];
  hiveHostnames?: string[];
}

export async function getWorkspaceAppIsolationContext(): Promise<WorkspaceAppIsolationContext> {
  const configuredOrigin = process.env.HIVE_PUBLIC_ORIGIN?.trim();
  const requestHost = (await headers()).get("host");
  if (!configuredOrigin && !requestHost)
    throw new Error("Hive host is unavailable for workspace tools.");
  const urls = [configuredOrigin, requestHost ? `https://${requestHost}` : null]
    .filter((value): value is string => Boolean(value))
    .map((value) => new URL(value));
  for (const url of urls) {
    if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username || url.password) {
      throw new Error("Invalid Hive origin for workspace tools.");
    }
  }
  const hiveHostnames = [...new Set(urls.map((url) => url.hostname))];
  return {
    hiveHostname: hiveHostnames[0],
    hiveHostnames,
    // Include cookie domains cleared during migration: browsers may still carry them.
    cookieDomains: [...new Set(hiveHostnames.flatMap(sessionCookieDomainsToClear))],
  };
}

export async function getIsolatedWorkspaceAppAuthRedirect(
  client: Pick<CoderClient, "getApplicationAuthRedirect">,
  requestedUrl: string,
  context: Awaited<ReturnType<typeof getWorkspaceAppIsolationContext>>,
): Promise<string> {
  const target = assertWorkspaceAppIsolated(
    requestedUrl,
    context.hiveHostname,
    context.cookieDomains,
    context.hiveHostnames,
  );
  const redirect = await client.getApplicationAuthRedirect(target.toString());
  const redirectUrl = assertWorkspaceAppIsolated(
    redirect,
    context.hiveHostname,
    context.cookieDomains,
    context.hiveHostnames,
  );
  if (redirectUrl.origin !== target.origin)
    throw new Error("Unexpected workspace app authentication origin.");
  return redirectUrl.toString();
}
