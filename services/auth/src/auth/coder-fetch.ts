import { Agent, fetch as undiciFetch } from "undici";

export async function fetchCoderApi(
  input: string | URL,
  init: RequestInit = {},
): Promise<Response> {
  const configuredCa = process.env.CODER_CA_CERT?.trim();
  if (!configuredCa) return fetch(input, init);

  const dispatcher = new Agent({ connect: { ca: configuredCa } });
  try {
    const response = await undiciFetch(input, {
      method: init.method,
      headers: Object.fromEntries(new Headers(init.headers).entries()),
      body: typeof init.body === "string" ? init.body : undefined,
      redirect: init.redirect,
      signal: init.signal ?? undefined,
      dispatcher,
    });
    const body = await response.arrayBuffer();
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
