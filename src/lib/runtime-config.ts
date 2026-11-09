export interface WorkspaceMenuCapabilities {
  projectTemplateIds: string[];
  readTemplateIds: string[];
  terminalEnabled: boolean;
}
export interface RuntimeConfig {
  terminalWsUrl: string;
  codexVoiceEnabled?: true;
  projectDiscoveryEnabled?: true;
  projectTasksEnabled?: true;
  deliveryEnabled?: true;
  workspaceCapabilities?: WorkspaceMenuCapabilities;
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

const templateId = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
function templateIds(raw: unknown): string[] {
  return Array.isArray(raw) &&
    raw.length <= 32 &&
    raw.every((v) => typeof v === "string" && templateId.test(v)) &&
    new Set(raw).size === raw.length
    ? raw
    : [];
}
function publicWorkspaceCapabilities(): WorkspaceMenuCapabilities | undefined {
  if (process.env.HIVE_RUNTIME_TARGET !== "cloudflare") return undefined;
  let readTemplateIds: string[] = [];
  try {
    const profiles: unknown = JSON.parse(process.env.HIVE_WORKSPACE_READ_PROFILES_JSON ?? "[]");
    if (process.env.HIVE_WORKSPACE_READ_ENABLED === "true" && Array.isArray(profiles))
      readTemplateIds = templateIds(profiles.map((p) => p?.templateId));
  } catch {
    /* Malformed enrollment is unavailable; never fall back to SSH. */
  }
  return {
    projectTemplateIds:
      process.env.HIVE_CODEX_GATEWAY_ENABLED === "true" &&
      process.env.HIVE_PROJECT_DISCOVERY_ENABLED === "true"
        ? templateIds((process.env.HIVE_CODEX_SOFTWARE_TEMPLATE_IDS ?? "").split(","))
        : [],
    readTemplateIds,
    terminalEnabled: process.env.HIVE_GENERIC_TERMINAL_ENABLED === "true",
  };
}
function parseWorkspaceCapabilities(raw: unknown): WorkspaceMenuCapabilities {
  if (
    !raw ||
    typeof raw !== "object" ||
    !("projectTemplateIds" in raw) ||
    !("readTemplateIds" in raw) ||
    !("terminalEnabled" in raw) ||
    typeof raw.terminalEnabled !== "boolean"
  )
    return { projectTemplateIds: [], readTemplateIds: [], terminalEnabled: false };
  return {
    projectTemplateIds: templateIds(raw.projectTemplateIds),
    readTemplateIds: templateIds(raw.readTemplateIds),
    terminalEnabled: raw.terminalEnabled,
  };
}

export function getServerRuntimeConfig(): RuntimeConfig {
  const workspaceCapabilities = publicWorkspaceCapabilities();
  return {
    terminalWsUrl: serverTerminalWsUrl(),
    ...(workspaceCapabilities ? { workspaceCapabilities } : {}),
    ...(process.env.HIVE_PROJECT_TASKS_ENABLED === "true"
      ? { projectTasksEnabled: true as const }
      : {}),
    ...(process.env.HIVE_DELIVERY_ENABLED === "true" ? { deliveryEnabled: true as const } : {}),
    ...(process.env.HIVE_PROJECT_DISCOVERY_ENABLED === "true"
      ? { projectDiscoveryEnabled: true as const }
      : {}),
    ...(process.env.HIVE_CODEX_VOICE_ENABLED === "true"
      ? { codexVoiceEnabled: true as const }
      : {}),
  };
}

/** The Worker pilot has one same-origin terminal relay; its runtime setting must
 * not depend on a NEXT_PUBLIC value substituted when the application was built. */
export function serverTerminalWsUrl(): string {
  if (process.env.HIVE_RUNTIME_TARGET === "cloudflare" && process.env.HIVE_TERMINAL_WS_URL)
    return process.env.HIVE_TERMINAL_WS_URL === "/" ? "/" : "";
  return process.env.NEXT_PUBLIC_TERMINAL_WS_URL ?? "";
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
      return {
        terminalWsUrl: parsed.terminalWsUrl,
        ...("workspaceCapabilities" in parsed
          ? { workspaceCapabilities: parseWorkspaceCapabilities(parsed.workspaceCapabilities) }
          : {}),
        ...("projectTasksEnabled" in parsed && parsed.projectTasksEnabled === true
          ? { projectTasksEnabled: true as const }
          : {}),
        ...("deliveryEnabled" in parsed && parsed.deliveryEnabled === true
          ? { deliveryEnabled: true as const }
          : {}),
        ...("projectDiscoveryEnabled" in parsed && parsed.projectDiscoveryEnabled === true
          ? { projectDiscoveryEnabled: true as const }
          : {}),
        ...("codexVoiceEnabled" in parsed && parsed.codexVoiceEnabled === true
          ? { codexVoiceEnabled: true as const }
          : {}),
      };
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
    ...("workspaceCapabilities" in runtimeConfig
      ? { workspaceCapabilities: parseWorkspaceCapabilities(runtimeConfig.workspaceCapabilities) }
      : {}),
    ...(runtimeConfig.projectTasksEnabled ? { projectTasksEnabled: true as const } : {}),
    ...(runtimeConfig.deliveryEnabled ? { deliveryEnabled: true as const } : {}),
    ...(runtimeConfig.projectDiscoveryEnabled ? { projectDiscoveryEnabled: true as const } : {}),
    ...(runtimeConfig.codexVoiceEnabled ? { codexVoiceEnabled: true as const } : {}),
  };
}
