import type { WorkspaceProfileId } from "@/lib/workspaces/profiles";

export interface WorkspaceTemplateCapabilities {
  browser: boolean;
  desktop: boolean;
  editor: boolean;
  fileBrowser: boolean;
  web3: boolean;
}

const HEADLESS_DEVELOPMENT_CAPABILITIES = {
  browser: false,
  desktop: false,
  editor: true,
  fileBrowser: true,
  web3: false,
} as const satisfies WorkspaceTemplateCapabilities;

export const TEMPLATE_CATALOG = [
  {
    name: "ai-dev-k8s",
    profileId: "software",
    runtime: "kubernetes",
    imageVariant: "cli",
    capabilities: { ...HEADLESS_DEVELOPMENT_CAPABILITIES, web3: true },
    description:
      "Persistent command center for software delivery and coordinating specialist workspaces.",
  },
  {
    name: "browser-testing",
    profileId: "browser",
    runtime: "kubernetes",
    imageVariant: "browser",
    capabilities: {
      browser: true,
      desktop: true,
      editor: true,
      fileBrowser: true,
      web3: false,
    },
    description: "Dedicated Chrome and Playwright workspace for browser automation and inspection.",
  },
  {
    name: "game-dev",
    profileId: "game",
    runtime: "kubernetes",
    imageVariant: "game",
    capabilities: {
      browser: false,
      desktop: true,
      editor: true,
      fileBrowser: true,
      web3: false,
    },
    description: "Desktop workspace for Unity, Blender, assets, shaders, and gameplay.",
  },
  {
    name: "electronics",
    profileId: "electronics",
    runtime: "kubernetes",
    imageVariant: "electronics",
    capabilities: {
      browser: false,
      desktop: true,
      editor: true,
      fileBrowser: true,
      web3: false,
    },
    description: "Desktop workspace for KiCad design, simulation, and hardware repositories.",
  },
  {
    name: "infrastructure",
    profileId: "infrastructure",
    runtime: "kubernetes",
    imageVariant: "infrastructure",
    capabilities: HEADLESS_DEVELOPMENT_CAPABILITIES,
    description: "Headless workspace for clusters, Terraform, deployments, and platform work.",
  },
] as const satisfies ReadonlyArray<{
  name: string;
  profileId: WorkspaceProfileId;
  runtime: "kubernetes";
  imageVariant: "cli" | "infrastructure" | "game" | "electronics" | "browser";
  capabilities: WorkspaceTemplateCapabilities;
  description: string;
}>;

export type TemplateCatalogEntry = (typeof TEMPLATE_CATALOG)[number];
export type KnownTemplate = TemplateCatalogEntry["name"];

export const KNOWN_TEMPLATES: readonly KnownTemplate[] = TEMPLATE_CATALOG.map(({ name }) => name);

const TEMPLATE_BY_NAME = new Map<string, TemplateCatalogEntry>(
  TEMPLATE_CATALOG.map((template) => [template.name, template]),
);

const RETIRED_TEMPLATE_NAMES = new Set(["orchestrator"]);

const LEGACY_TEMPLATE_CAPABILITIES = new Map<string, WorkspaceTemplateCapabilities>([
  [
    "orchestrator",
    {
      browser: false,
      desktop: false,
      editor: false,
      fileBrowser: false,
      web3: false,
    },
  ],
]);

const EXTERNAL_TEMPLATE_CAPABILITIES: WorkspaceTemplateCapabilities = {
  browser: false,
  desktop: true,
  editor: true,
  fileBrowser: true,
  web3: false,
};

export function templateCatalogEntry(templateName: string): TemplateCatalogEntry | null {
  return TEMPLATE_BY_NAME.get(templateName.trim().toLowerCase()) ?? null;
}

export function isRetiredWorkspaceTemplate(templateName: string): boolean {
  return RETIRED_TEMPLATE_NAMES.has(templateName.trim().toLowerCase());
}

export function workspaceTemplateCapabilities(templateName: string): WorkspaceTemplateCapabilities {
  const normalizedName = templateName.trim().toLowerCase();
  return (
    templateCatalogEntry(normalizedName)?.capabilities ??
    LEGACY_TEMPLATE_CAPABILITIES.get(normalizedName) ??
    EXTERNAL_TEMPLATE_CAPABILITIES
  );
}

export function workspaceSurfaceLabel(templateName: string): string {
  const definition = templateCatalogEntry(templateName);
  const legacyCapabilities = LEGACY_TEMPLATE_CAPABILITIES.get(templateName.trim().toLowerCase());
  const capabilities = definition?.capabilities ?? legacyCapabilities;
  if (!capabilities) return "External";
  if (capabilities.browser) return "Browser + desktop";
  if (capabilities.desktop) return "Desktop";
  if (capabilities.editor || capabilities.fileBrowser) {
    return "CLI + web tools";
  }
  return "CLI";
}
