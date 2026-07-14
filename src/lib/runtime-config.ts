export interface RuntimeConfig {
  terminalWsUrl: string;
}

interface BrowserLocation {
  host: string;
  protocol: string;
}

declare global {
  interface Window {
    __HIVE_CONFIG__?: RuntimeConfig;
  }
}

export function getServerRuntimeConfig(): RuntimeConfig {
  return {
    terminalWsUrl: process.env.NEXT_PUBLIC_TERMINAL_WS_URL ?? "",
  };
}

export function resolveTerminalWsUrl(
  configuredUrl: string,
  browserLocation?: BrowserLocation,
): string {
  if (!configuredUrl.startsWith("/") || configuredUrl.startsWith("//")) return configuredUrl;
  if (!browserLocation?.host) return "";

  const protocol = browserLocation.protocol === "https:" ? "wss:" : "ws:";
  const path = configuredUrl === "/" ? "" : configuredUrl.replace(/\/$/, "");
  return `${protocol}//${browserLocation.host}${path}`;
}

export function getClientRuntimeConfig(): RuntimeConfig {
  const runtimeConfig =
    typeof window !== "undefined" && window.__HIVE_CONFIG__
      ? window.__HIVE_CONFIG__
      : {
          // Fallback for dev (Next inlines NEXT_PUBLIC_* at build time) and tests.
          terminalWsUrl: process.env.NEXT_PUBLIC_TERMINAL_WS_URL ?? "",
        };

  const browserLocation = typeof window !== "undefined" ? window.location : undefined;

  return {
    terminalWsUrl: resolveTerminalWsUrl(runtimeConfig.terminalWsUrl, browserLocation),
  };
}
