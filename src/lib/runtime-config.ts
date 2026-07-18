export interface RuntimeConfig {
  terminalWsUrl: string;
}

export const RUNTIME_CONFIG_ELEMENT_ID = "hive-runtime-config";

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

export function serializeRuntimeConfig(config: RuntimeConfig): string {
  return JSON.stringify(config)
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

export function serializeRuntimeConfigScript(config: RuntimeConfig): string {
  return `window.__HIVE_CONFIG__=${serializeRuntimeConfig(config)};`;
}

export function parseRuntimeConfig(value: string | null | undefined): RuntimeConfig | null {
  if (!value) return null;

  try {
    const parsed: unknown = JSON.parse(value);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "terminalWsUrl" in parsed &&
      typeof parsed.terminalWsUrl === "string"
    ) {
      return { terminalWsUrl: parsed.terminalWsUrl };
    }
  } catch {
    // Invalid runtime data falls through to the build-time development fallback.
  }

  return null;
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
  const domConfig =
    typeof document !== "undefined"
      ? parseRuntimeConfig(document.getElementById(RUNTIME_CONFIG_ELEMENT_ID)?.textContent)
      : null;
  const runtimeConfig =
    typeof window !== "undefined" && window.__HIVE_CONFIG__
      ? window.__HIVE_CONFIG__
      : domConfig
        ? domConfig
        : {
            // Fallback for dev (Next inlines NEXT_PUBLIC_* at build time) and tests.
            terminalWsUrl: process.env.NEXT_PUBLIC_TERMINAL_WS_URL ?? "",
          };

  const browserLocation = typeof window !== "undefined" ? window.location : undefined;

  return {
    terminalWsUrl: resolveTerminalWsUrl(runtimeConfig.terminalWsUrl, browserLocation),
  };
}
