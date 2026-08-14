import type { WorkspaceProfileId } from "@/lib/workspaces/profiles";

export const TEMPLATE_CATALOG = [
  {
    name: "orchestrator",
    profileId: "orchestrator",
    runtime: "kubernetes",
    description: "Persistent command center for coordinating specialist workspaces.",
  },
  {
    name: "ai-dev",
    profileId: "software",
    runtime: "docker",
    description: "General-purpose software workspace backed by Docker.",
  },
  {
    name: "ai-dev-k8s",
    profileId: "software",
    runtime: "kubernetes",
    description: "General-purpose software workspace backed by Kubernetes.",
  },
  {
    name: "game-dev",
    profileId: "game",
    runtime: "kubernetes",
    description: "Unity, Blender, asset, shader, and gameplay workspace.",
  },
  {
    name: "electronics",
    profileId: "electronics",
    runtime: "kubernetes",
    description: "KiCad design, simulation, and hardware repository workspace.",
  },
  {
    name: "infrastructure",
    profileId: "infrastructure",
    runtime: "kubernetes",
    description: "Cluster, Terraform, deployment, runner, and platform workspace.",
  },
] as const satisfies ReadonlyArray<{
  name: string;
  profileId: WorkspaceProfileId;
  runtime: "docker" | "kubernetes";
  description: string;
}>;

export type TemplateCatalogEntry = (typeof TEMPLATE_CATALOG)[number];
export type KnownTemplate = TemplateCatalogEntry["name"];

export const KNOWN_TEMPLATES: readonly KnownTemplate[] = TEMPLATE_CATALOG.map(({ name }) => name);

const TEMPLATE_BY_NAME = new Map<string, TemplateCatalogEntry>(
  TEMPLATE_CATALOG.map((template) => [template.name, template]),
);

export function templateCatalogEntry(templateName: string): TemplateCatalogEntry | null {
  return TEMPLATE_BY_NAME.get(templateName.trim().toLowerCase()) ?? null;
}
