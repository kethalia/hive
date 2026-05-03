"use client";

import { useCallback } from "react";
import { Plus, Terminal } from "lucide-react";
import {
  CommandDialog,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandGroup,
  CommandItem,
  CommandShortcut,
} from "@/components/ui/command";

interface CommandPaletteProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  tabs: Array<{ id: string; sessionName: string }>;
  onSelectTab: (tabId: string) => void;
  onCreateSession?: () => void;
}

export function CommandPalette({
  open,
  onOpenChange,
  tabs,
  onSelectTab,
  onCreateSession,
}: CommandPaletteProps) {
  const handleSelect = useCallback(
    (tabId: string) => {
      onSelectTab(tabId);
      onOpenChange(false);
    },
    [onSelectTab, onOpenChange],
  );

  const handleCreate = useCallback(() => {
    onCreateSession?.();
    onOpenChange(false);
  }, [onCreateSession, onOpenChange]);

  return (
    <CommandDialog open={open} onOpenChange={onOpenChange}>
      <CommandInput placeholder="Search sessions…" />
      <CommandList>
        <CommandEmpty>No sessions found.</CommandEmpty>
        <CommandGroup heading="Sessions">
          {tabs.map((tab) => (
            <CommandItem
              key={tab.id}
              value={tab.sessionName}
              onSelect={() => handleSelect(tab.id)}
            >
              <Terminal className="mr-2 size-4 shrink-0 opacity-70" />
              <span className="font-mono text-sm">{tab.sessionName}</span>
            </CommandItem>
          ))}
        </CommandGroup>
        {onCreateSession && (
          <CommandGroup heading="Actions">
            <CommandItem onSelect={handleCreate}>
              <Plus className="mr-2 size-4 shrink-0 opacity-70" />
              <span>New Session</span>
              <CommandShortcut>Ctrl+T</CommandShortcut>
            </CommandItem>
          </CommandGroup>
        )}
      </CommandList>
    </CommandDialog>
  );
}
