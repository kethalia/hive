import type { DockVariant } from "@/components/experimental/workspace-dock";

export const DOCK_VARIANTS = [
  {
    id: "phosphor",
    name: "Phosphor",
    description:
      "A quiet green rail. Flat surfaces, small labels, and the same border treatment as Hive.",
    note: "Closest to Hive",
  },
  {
    id: "outline",
    name: "Outline",
    description: "Four separate square controls. No tray, no blur, just icons and fine outlines.",
    note: "Minimal",
  },
  {
    id: "keycaps",
    name: "Keycaps",
    description:
      "Raised keys with a visible bottom-left edge. Hover lifts each cap; pressing sinks it into its base.",
    note: "Selected direction",
  },
  {
    id: "console",
    name: "Console",
    description:
      "A slim command bar with readable text. Familiar terminal controls with very little chrome.",
    note: "Text first",
  },
  {
    id: "glass",
    name: "Glass",
    description:
      "The original macOS-style dock, kept here so you can compare it with the quieter options.",
    note: "Original",
  },
] as const satisfies readonly {
  id: DockVariant;
  name: string;
  description: string;
  note: string;
}[];
