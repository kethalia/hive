import { rootCertificates } from "node:tls";
import { Agent, fetch as undiciFetch } from "undici";

const NULL_BODY_STATUSES = new Set([204, 205, 304]);

export async function fetchCoderApi(
  input: string | URL,
  init: RequestInit = {},
): Promise<Response> {
  // App auth-redirect explicitly requests manual handling; credential-bearing
  // API requests must never follow redirects, including with a private CA.
  const redirect = init.redirect === "manual" ? "manual" : "error";
  const configuredCa = process.env.CODER_CA_CERT?.trim();
  if (!configuredCa) return fetch(input, { ...init, redirect });

  const dispatcher = new Agent({ connect: { ca: [...rootCertificates, configuredCa] } });
  try {
    const response = await undiciFetch(input, {
      method: init.method,
      headers: Object.fromEntries(new Headers(init.headers).entries()),
      body: typeof init.body === "string" ? init.body : undefined,
      redirect,
      signal: init.signal ?? undefined,
      dispatcher,
    });
    const body = NULL_BODY_STATUSES.has(response.status) ? null : await response.arrayBuffer();
    const headers = new Headers();
    response.headers.forEach((value, key) => {
      headers.set(key, value);
    });
    return new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  } finally {
    await dispatcher.close();
  }
}
