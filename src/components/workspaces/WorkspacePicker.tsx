"use client";

import { useId } from "react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { CoderWorkspace } from "@/lib/coder/types";

export function WorkspacePicker({
  label,
  workspaces,
  selected,
  onSelect,
  disabled,
}: {
  label: string;
  workspaces: CoderWorkspace[];
  selected?: string;
  onSelect: (id: string) => void;
  disabled?: boolean;
}) {
  const id = useId();
  const items = workspaces.map((workspace) => ({
    value: workspace.id,
    label: `${workspace.name} · ${workspace.latest_build.status}`,
  }));
  return (
    <div className="space-y-2 text-sm">
      <label htmlFor={id} className="block">
        Coder workspace
      </label>
      <Select
        value={selected ?? null}
        onValueChange={(value) => {
          if (value) onSelect(value);
        }}
        disabled={disabled || !items.length}
        items={items}
      >
        <SelectTrigger id={id} aria-label={label} className="w-full">
          <SelectValue
            className="min-w-0 truncate"
            placeholder={items.length ? "Choose a workspace" : "No workspaces available"}
          />
        </SelectTrigger>
        <SelectContent>
          {items.map(({ value, label }) => (
            <SelectItem key={value} value={value}>
              {label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
