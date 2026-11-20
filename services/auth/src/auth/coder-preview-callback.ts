import type { PrismaClient } from "@hive/db";
import { boundedCoderJson } from "./bounded-coder-json";
import { fetchCoderApi } from "./coder-fetch";
import { type CoderOAuthConfig, isCoderOAuthPreview } from "./coder-oauth-config";

const MAX_CODER_REDIRECTS = 32;
const previewCallback =
  /^https:\/\/[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.hive-preview\.kethalia\.com\/api\/auth\/callback\/coder$/;

/** Coder requires an exact redirect. Register it on first use of a Preview. */
export async function registerCoderPreviewCallback(
  config: CoderOAuthConfig,
  db: PrismaClient,
  signal: AbortSignal,
): Promise<void> {
  if (!isCoderOAuthPreview()) return;
  const token = process.env.HIVE_PREVIEW_CODER_REGISTRATION_TOKEN;
  if (!token || !previewCallback.test(config.callbackUrl))
    throw Error("coder_preview_callback_configuration");

  const endpoint = new URL(
    `/oauth2/clients/${encodeURIComponent(config.clientId)}`,
    config.coderOrigin,
  );
  const requestOptions: RequestInit = {
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    redirect: "manual",
    credentials: "omit",
    cache: "no-store",
    signal: AbortSignal.any([signal, AbortSignal.timeout(8_000)]),
  };
  // Coder replaces the list on every update. Serialize the read and write across Previews.
  let stage = "database";
  try {
    await db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${endpoint.href}, 0))`;
      stage = "read";
      const response = await fetchCoderApi(endpoint.href, requestOptions);
      if (!response.ok || response.redirected) {
        await response.body?.cancel();
        throw Error(`coder_preview_callback_read_${response.status}`);
      }
      stage = "metadata";
      const registration = await boundedCoderJson(response, requestOptions.signal ?? signal);
      const redirects: unknown = registration.redirect_uris;
      if (
        registration.client_id !== config.clientId ||
        !Array.isArray(redirects) ||
        !redirects.every((uri) => typeof uri === "string" && previewCallback.test(uri))
      )
        throw Error("coder_preview_callback_metadata");

      if (
        redirects.includes(config.callbackUrl) &&
        (redirects.length < MAX_CODER_REDIRECTS || redirects[0] === config.callbackUrl)
      )
        return;

      stage = "update";
      const update = await fetchCoderApi(endpoint.href, {
        ...requestOptions,
        method: "PUT",
        body: JSON.stringify({
          client_name: registration.client_name,
          redirect_uris: [
            config.callbackUrl,
            ...redirects.filter((uri) => uri !== config.callbackUrl),
          ].slice(0, MAX_CODER_REDIRECTS),
          token_endpoint_auth_method: registration.token_endpoint_auth_method,
          grant_types: registration.grant_types,
          response_types: registration.response_types,
          scope: registration.scope,
        }),
      });
      await update.body?.cancel();
      if (!update.ok || update.redirected)
        throw Error(`coder_preview_callback_update_${update.status}`);
    });
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("coder_preview_callback_")) throw error;
    const cause = error as { code?: unknown; errorCode?: unknown };
    const code = cause?.code ?? cause?.errorCode;
    let suffix = typeof code === "string" && /^P[0-9]{4}$/.test(code) ? `_${code}` : "";
    if (error instanceof Error && /(?:timeout|abort|deadline)/i.test(error.name))
      suffix = "_deadline";
    else if (error instanceof TypeError && /(?:network|fetch|redirect|socket)/i.test(error.message))
      suffix = "_transport";
    throw Error(`coder_preview_callback_${stage}${suffix}`);
  }
}
