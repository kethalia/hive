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
  { id: "game", pattern: /game|unity|unreal|godot|blender/ },
  { id: "electronics", pattern: /electronic|hardware|kicad|pcb|firmware/ },
  { id: "software", pattern: /ai[-_ ]?dev|software|full[-_ ]?stack|web[-_ ]?dev|developer/ },
  { id: "infrastructure", pattern: /infrastructure|platform|devops|terraform|cluster|ops/ },
];

export function workspaceProfileForTemplate(templateName: string): WorkspaceProfile {
  const normalizedName = templateName.trim().toLowerCase();
  const match = PROFILE_PATTERNS.find(({ pattern }) => pattern.test(normalizedName));
  return (
    WORKSPACE_PROFILES.find(({ id }) => id === (match?.id ?? "custom")) ?? WORKSPACE_PROFILES[5]
  );
}
