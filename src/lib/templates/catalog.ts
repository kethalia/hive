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
    name: "orchestrator",
    profileId: "orchestrator",
    runtime: "kubernetes",
    imageVariant: "cli",
    capabilities: {
      ...HEADLESS_DEVELOPMENT_CAPABILITIES,
      editor: false,
      fileBrowser: false,
    },
    description: "Headless command center for coordinating specialist workspaces from the TUI.",
  },
  {
    name: "ai-dev-k8s",
    profileId: "software",
    runtime: "kubernetes",
    imageVariant: "cli",
    capabilities: { ...HEADLESS_DEVELOPMENT_CAPABILITIES, web3: true },
    description: "Headless software workspace for implementation, CI, and code review.",
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
    imageVariant: "cli",
    capabilities: HEADLESS_DEVELOPMENT_CAPABILITIES,
    description: "Headless workspace for clusters, Terraform, deployments, and platform work.",
  },
] as const satisfies ReadonlyArray<{
  name: string;
  profileId: WorkspaceProfileId;
  runtime: "kubernetes";
  imageVariant: "cli" | "game" | "electronics" | "browser";
  capabilities: WorkspaceTemplateCapabilities;
  description: string;
}>;

export type TemplateCatalogEntry = (typeof TEMPLATE_CATALOG)[number];
export type KnownTemplate = TemplateCatalogEntry["name"];

export const KNOWN_TEMPLATES: readonly KnownTemplate[] = TEMPLATE_CATALOG.map(({ name }) => name);

const TEMPLATE_BY_NAME = new Map<string, TemplateCatalogEntry>(
  TEMPLATE_CATALOG.map((template) => [template.name, template]),
);

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

export function workspaceTemplateCapabilities(templateName: string): WorkspaceTemplateCapabilities {
  return templateCatalogEntry(templateName)?.capabilities ?? EXTERNAL_TEMPLATE_CAPABILITIES;
}

export function workspaceSurfaceLabel(templateName: string): string {
  const definition = templateCatalogEntry(templateName);
  if (!definition) return "External";
  if (definition.capabilities.browser) return "Browser + desktop";
  if (definition.capabilities.desktop) return "Desktop";
  if (definition.capabilities.editor || definition.capabilities.fileBrowser) {
    return "CLI + web tools";
  }
  return "CLI";
}
