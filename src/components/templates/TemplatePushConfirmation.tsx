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
  names?: string[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
}

export function TemplatePushConfirmation({
  name,
  names,
  open,
  onOpenChange,
  onConfirm,
}: TemplatePushConfirmationProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {names && names.length > 1
              ? `Push all ${names.length} templates?`
              : `Push ${name ?? "template"}?`}
          </DialogTitle>
          <DialogDescription>
            This creates and activates a new Coder template version from the files in this Hive
            deployment. Existing workspaces are not rebuilt automatically.
          </DialogDescription>
        </DialogHeader>
        {names && names.length > 1 ? (
          <ul className="max-h-48 overflow-y-auto pl-5 text-sm list-disc">
            {names.map((template) => (
              <li key={template}>{template}</li>
            ))}
          </ul>
        ) : null}
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
            {names && names.length > 1 ? " all" : ""}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
