import { isRetiredWorkspaceTemplate, templateCatalogEntry } from "@/lib/templates/catalog";

const LEGACY_ORCHESTRATOR_PROFILE = {
  id: "orchestrator",
  label: "Legacy orchestrator",
  description: "A retired command-center profile retained for existing workspaces.",
} as const;

export const WORKSPACE_PROFILES = [
  {
    id: "software",
    label: "Development & orchestration",
    description:
      "The persistent main workspace for repositories, implementation, reviews, and specialist coordination.",
  },
  {
    id: "browser",
    label: "Browser testing",
    description: "A dedicated Chrome and Playwright environment for browser validation.",
  },
  {
    id: "interview",
    label: "Technical interview",
    description:
      "An isolated, credential-minimal environment for time-boxed full-stack assessments.",
  },
  {
    id: "game",
    label: "Game development",
    description: "An interactive environment for engines, content tools, and visual iteration.",
  },
  {
    id: "electronics",
    label: "Electronics",
    description: "A hardware workspace for PCB design, simulation, and firmware tooling.",
  },
  {
    id: "infrastructure",
    label: "Infrastructure",
    description: "An operations environment for clusters, Terraform, and platform work.",
  },
  {
    id: "custom",
    label: "Custom",
    description: "A specialized Coder template that does not match a built-in profile yet.",
  },
] as const;

export type WorkspaceProfile =
  | (typeof WORKSPACE_PROFILES)[number]
  | typeof LEGACY_ORCHESTRATOR_PROFILE;
export type WorkspaceProfileId = WorkspaceProfile["id"];

const PROFILE_PATTERNS: ReadonlyArray<{
  id: Exclude<WorkspaceProfileId, "custom" | "orchestrator">;
  pattern: RegExp;
}> = [
  { id: "interview", pattern: /technical[-_ ]?interview|proton[-_ ]?interview/ },
  { id: "browser", pattern: /browser|playwright|chrome|end[-_ ]?to[-_ ]?end|e2e/ },
  { id: "game", pattern: /game|unity|unreal|godot|blender/ },
  { id: "electronics", pattern: /electronic|hardware|kicad|pcb|firmware/ },
  { id: "software", pattern: /ai[-_ ]?dev|software|full[-_ ]?stack|web[-_ ]?dev|developer/ },
  { id: "infrastructure", pattern: /infrastructure|platform|devops|terraform|cluster|ops/ },
];

const WORKSPACE_PROFILE_BY_ID = new Map<WorkspaceProfileId, WorkspaceProfile>(
  [...WORKSPACE_PROFILES, LEGACY_ORCHESTRATOR_PROFILE].map((profile) => [profile.id, profile]),
);

function workspaceProfileById(id: WorkspaceProfileId): WorkspaceProfile {
  const profile = WORKSPACE_PROFILE_BY_ID.get(id);
  if (!profile) throw new Error(`Unknown workspace profile: ${id}`);
  return profile;
}

export function workspaceProfileForTemplate(templateName: string): WorkspaceProfile {
  const normalizedName = templateName.trim().toLowerCase();
  if (isRetiredWorkspaceTemplate(normalizedName)) {
    return workspaceProfileById("orchestrator");
  }
  const catalogProfileId = templateCatalogEntry(normalizedName)?.profileId;
  const match = PROFILE_PATTERNS.find(({ pattern }) => pattern.test(normalizedName));
  return workspaceProfileById(catalogProfileId ?? match?.id ?? "custom");
}
