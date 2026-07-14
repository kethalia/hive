"use client";

import { Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

interface TemplatePushConfirmationProps {
  name: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
}

export function TemplatePushConfirmation({
  name,
  open,
  onOpenChange,
  onConfirm,
}: TemplatePushConfirmationProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Push {name ?? "template"}?</DialogTitle>
          <DialogDescription>
            This creates and activates a new Coder template version from the files in this Hive
            deployment. Existing workspaces are not rebuilt automatically.
          </DialogDescription>
        </DialogHeader>
        <div className="border-l-2 border-amber-400/70 bg-amber-400/5 px-4 py-3 text-sm text-muted-foreground">
          Review the template status and hashes before continuing. Live push output will remain
          visible until you close it.
        </div>
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => {
              onOpenChange(false);
            }}
          >
            Cancel
          </Button>
          <Button type="button" onClick={onConfirm}>
            <Upload className="size-4" aria-hidden="true" /> Confirm push
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
