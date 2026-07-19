import { rootCertificates } from "node:tls";
import { Agent, fetch as undiciFetch } from "undici";

const NULL_BODY_STATUSES = new Set([204, 205, 304]);

export function getCoderCaCertificates(): string[] | undefined {
  const configuredCa = process.env.CODER_CA_CERT?.trim();
  return configuredCa ? [...rootCertificates, configuredCa] : undefined;
}

export async function fetchCoderApi(
  input: string | URL,
  init: RequestInit = {},
): Promise<Response> {
  const ca = getCoderCaCertificates();
  if (!ca) return fetch(input, init);

  const dispatcher = new Agent({ connect: { ca } });
  try {
    const response = await undiciFetch(input, {
      method: init.method,
      headers: Object.fromEntries(new Headers(init.headers).entries()),
      body: typeof init.body === "string" ? init.body : undefined,
      redirect: init.redirect,
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
