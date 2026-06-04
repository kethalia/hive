"use client";

import * as React from "react";
import {
  useKeybindings,
  useRegisterKeybinding,
  type KeybindingEntry,
} from "@/hooks/useKeybindings";
import { usePwaStandalone } from "@/lib/terminal/pwa";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { formatShortcut, isApplePlatform } from "@/lib/keyboard-shortcuts";
import { XIcon } from "lucide-react";

const NUDGE_DISMISSED_KEY = "hive:help-nudge-dismissed";

function groupByCategory(entries: KeybindingEntry[]): Record<string, KeybindingEntry[]> {
  const groups: Record<string, KeybindingEntry[]> = {};
  for (const entry of entries) {
    const cat = entry.category || "other";
    groups[cat] ??= [];
    groups[cat].push(entry);
  }
  return groups;
}

export function HelpOverlay() {
  const [open, setOpen] = React.useState(false);
  const { getAll } = useKeybindings();
  const isStandalone = usePwaStandalone();
  const isMac = React.useMemo(() => isApplePlatform(), []);
  const [nudgeDismissed, setNudgeDismissed] = React.useState(true);

  React.useEffect(() => {
    try {
      setNudgeDismissed(localStorage.getItem(NUDGE_DISMISSED_KEY) === "true");
    } catch {
      setNudgeDismissed(true);
    }
  }, []);

  useRegisterKeybinding({
    id: "help:show",
    keys: ["f1"],
    action: () => {
      setOpen((prev) => !prev);
      return false;
    },
    description: "Show keyboard shortcuts",
    category: "general",
    enabledInBrowser: true,
  });

  const entries = getAll();
  const groups = groupByCategory(entries);
  const categoryOrder = Object.keys(groups).sort((a, b) => {
    if (a === "general") return -1;
    if (b === "general") return 1;
    return a.localeCompare(b);
  });

  const showNudge = !isStandalone && !nudgeDismissed;

  function dismissNudge() {
    try {
      localStorage.setItem(NUDGE_DISMISSED_KEY, "true");
    } catch {
      // Ignore storage failures; the in-memory dismissal still applies.
    }
    setNudgeDismissed(true);
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="max-h-[80vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Keyboard Shortcuts</DialogTitle>
          <DialogDescription className="sr-only">
            List of available keyboard shortcuts grouped by category
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {categoryOrder.map((category) => (
            <div key={category}>
              <h3 className="mb-2 text-sm font-medium capitalize text-muted-foreground">
                {category}
              </h3>
              <div className="space-y-1">
                {groups[category].map((entry) => {
                  const isPwaOnly = !isStandalone && !entry.enabledInBrowser;
                  return (
                    <div
                      key={entry.id}
                      className="flex items-center justify-between rounded-md px-2 py-1.5 text-sm"
                    >
                      <span className={isPwaOnly ? "text-muted-foreground" : ""}>
                        {entry.description}
                        {isPwaOnly && (
                          <Badge variant="outline" className="ml-2 text-[10px]">
                            PWA only
                          </Badge>
                        )}
                      </span>
                      <kbd className="rounded border border-border bg-muted px-1.5 py-0.5 font-mono text-xs text-muted-foreground">
                        {formatShortcut(entry.keys, isMac)}
                      </kbd>
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>

        {showNudge && (
          <div className="mt-2 flex items-center justify-between rounded-md border border-border bg-muted/50 px-3 py-2 text-xs text-muted-foreground">
            <span>Install as app for more shortcuts</span>
            <button
              type="button"
              onClick={dismissNudge}
              className="ml-2 rounded p-0.5 hover:bg-muted"
            >
              <XIcon className="size-3" />
              <span className="sr-only">Dismiss</span>
            </button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
