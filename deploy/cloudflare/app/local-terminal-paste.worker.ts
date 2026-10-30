// Local-only actual runtime composition; all auth/Coder data is synthetic.
import { sessionCookieName, signCookie } from "@hive/auth";
import { terminalPasteRuntime } from "./terminal-paste-runtime";

type Env = {
  PROOF_BEARER: string;
  COOKIE_SECRET: string;
  AUTH_SERVICE_SECRET: string;
  PROVIDER: { fetch: typeof fetch };
};
export default {
  async fetch(request: Request, env: Env) {
    const url = new URL(request.url);
    const config = {
      HIVE_TERMINAL_PASTE_ENABLED: "true",
      HIVE_PREVIEW_ORIGIN: url.origin,
      CODER_URL: "https://coder.example",
      COOKIE_SECRET: env.COOKIE_SECRET,
      AUTH_SERVICE_SECRET: env.AUTH_SERVICE_SECRET,
      AUTH_SERVICE: env.PROVIDER,
    };
    if (url.pathname.startsWith("/__")) {
      if (request.headers.get("Authorization") !== `Bearer ${env.PROOF_BEARER}`)
        return new Response(null, { status: 401 });
      if (url.pathname === "/__paste/cookie")
        return Response.json({
          cookie: `${sessionCookieName()}=${signCookie("fixture-session", env.COOKIE_SECRET)}`,
        });
      if (url.pathname === "/__paste/off")
        return terminalPasteRuntime(
          request,
          { ...config, HIVE_TERMINAL_PASTE_ENABLED: "false" },
          env.PROVIDER.fetch.bind(env.PROVIDER),
        );
      return env.PROVIDER.fetch(new Request(`https://coder.example${url.pathname}`, request));
    }
    return terminalPasteRuntime(request, config, env.PROVIDER.fetch.bind(env.PROVIDER));
  },
};
