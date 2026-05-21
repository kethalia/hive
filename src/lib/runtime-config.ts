export interface RuntimeConfig {
  terminalWsUrl: string;
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

export function getClientRuntimeConfig(): RuntimeConfig {
  if (typeof window !== "undefined" && window.__HIVE_CONFIG__) {
    return window.__HIVE_CONFIG__;
  }
  // Fallback for dev (Next inlines NEXT_PUBLIC_* at build time) and tests.
  return {
    terminalWsUrl: process.env.NEXT_PUBLIC_TERMINAL_WS_URL ?? "",
  };
}
