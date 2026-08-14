import { templateCatalogEntry } from "@/lib/templates/catalog";

export const WORKSPACE_PROFILES = [
  {
    id: "orchestrator",
    label: "Orchestrator",
    description: "A persistent command center for coordinating work across other workspaces.",
  },
  {
    id: "software",
    label: "Software development",
    description: "A general-purpose coding environment for repositories, terminals, and reviews.",
  },
  {
    id: "browser",
    label: "Browser testing",
    description: "A dedicated Chrome and Playwright environment for browser validation.",
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

export type WorkspaceProfile = (typeof WORKSPACE_PROFILES)[number];
export type WorkspaceProfileId = WorkspaceProfile["id"];

const PROFILE_PATTERNS: ReadonlyArray<{
  id: Exclude<WorkspaceProfileId, "custom">;
  pattern: RegExp;
}> = [
  { id: "orchestrator", pattern: /orchestrat|command[-_ ]?center|control[-_ ]?plane/ },
  { id: "browser", pattern: /browser|playwright|chrome|end[-_ ]?to[-_ ]?end|e2e/ },
  { id: "game", pattern: /game|unity|unreal|godot|blender/ },
  { id: "electronics", pattern: /electronic|hardware|kicad|pcb|firmware/ },
  { id: "software", pattern: /ai[-_ ]?dev|software|full[-_ ]?stack|web[-_ ]?dev|developer/ },
  { id: "infrastructure", pattern: /infrastructure|platform|devops|terraform|cluster|ops/ },
];

const WORKSPACE_PROFILE_BY_ID = new Map<WorkspaceProfileId, WorkspaceProfile>(
  WORKSPACE_PROFILES.map((profile) => [profile.id, profile]),
);

function workspaceProfileById(id: WorkspaceProfileId): WorkspaceProfile {
  const profile = WORKSPACE_PROFILE_BY_ID.get(id);
  if (!profile) throw new Error(`Unknown workspace profile: ${id}`);
  return profile;
}

export function workspaceProfileForTemplate(templateName: string): WorkspaceProfile {
  const normalizedName = templateName.trim().toLowerCase();
  const catalogProfileId = templateCatalogEntry(normalizedName)?.profileId;
  const match = PROFILE_PATTERNS.find(({ pattern }) => pattern.test(normalizedName));
  return workspaceProfileById(catalogProfileId ?? match?.id ?? "custom");
}
