import { createHash } from "node:crypto";
import { openPortableVoiceClient } from "../../src/lib/codex/voice-portable-client.server";

export default {
  async fetch(
    request: Request,
    env: { HOST_URL: string; CONFIG_JSON: string; BINDING_JSON: string },
  ) {
    if (new URL(request.url).pathname !== "/proof") return new Response(null, { status: 404 });
    const config = JSON.parse(env.CONFIG_JSON),
      binding = JSON.parse(env.BINDING_JSON);
    const coder = {
      getBaseUrl: () => binding.coderOrigin,
      getApplicationsHost: async () => "*.apps.example.com",
      getApplicationAuthRedirect: async (url: string) =>
        `${url}?coder_application_connect_api_key_35e783=fixture`,
    };
    const cookieName = `coder_subdomain_app_session_token_${createHash("sha256").update("*.apps.example.com").digest("hex").slice(0, 32)}`;
    const fetcher: typeof fetch = (input, init) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      if (url.search)
        return Promise.resolve(
          new Response(null, {
            status: 303,
            headers: {
              Location: url.pathname,
              "Set-Cookie": `${cookieName}=fixture; Path=/; HttpOnly; Secure`,
            },
          }),
        );
      return fetch(`${env.HOST_URL}${url.pathname}`, init);
    };
    const rpc = await openPortableVoiceClient(
      config,
      coder,
      binding,
      undefined,
      AbortSignal.timeout(10000),
      fetcher,
    );
    try {
      return Response.json({ result: await rpc.request("thread/loaded/list", { limit: 100 }) });
    } finally {
      rpc.close();
    }
  },
};
