import { type DockVariant, WorkspaceDock } from "@/components/experimental/workspace-dock";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { DOCK_VARIANTS } from "./dock-variants";

const ignore = () => {};
const WORKSPACES = [
  { id: "1", name: "Workspace 1" },
  { id: "2", name: "Workspace 2" },
];

export function DockStyleComparison({
  open,
  onOpenChange,
  selected,
  onSelect,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  selected: DockVariant;
  onSelect: (variant: DockVariant) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="prototype-dialog variant-comparison">
        <DialogHeader>
          <DialogTitle>Dock styles</DialogTitle>
          <DialogDescription>
            Four directions using Hive’s colors and typography, plus the original glass dock. Choose
            one to try it on the workspace.
          </DialogDescription>
        </DialogHeader>
        <div className="variant-grid">
          {DOCK_VARIANTS.map((variant, index) => (
            <article
              key={variant.id}
              className="variant-card"
              data-selected={selected === variant.id}
            >
              <div className="variant-card-heading">
                <h3>
                  <span>{String(index + 1).padStart(2, "0")}</span>
                  {variant.name}
                </h3>
                <span>{variant.note}</span>
              </div>
              <div className="variant-sample crt-grid" inert aria-hidden="true">
                <WorkspaceDock
                  variant={variant.id}
                  density="compact"
                  workspaces={WORKSPACES}
                  activeWorkspaceId="1"
                  onWorkspaceSelect={ignore}
                  onWorkspaceCreate={ignore}
                  onAppsOpen={ignore}
                  onKeybindsOpen={ignore}
                  onKeyPress={ignore}
                  onAction={ignore}
                />
              </div>
              <p>{variant.description}</p>
              <Button
                type="button"
                variant={selected === variant.id ? "secondary" : "outline"}
                size="sm"
                onClick={() => onSelect(variant.id)}
              >
                Try {variant.name}
              </Button>
            </article>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}
