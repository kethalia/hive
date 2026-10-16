"use client";

import { XIcon } from "lucide-react";
import * as React from "react";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  type KeybindingEntry,
  useKeybindings,
  useRegisterKeybinding,
} from "@/hooks/useKeybindings";
import { formatShortcut, isApplePlatform } from "@/lib/keyboard-shortcuts";
import { usePwaStandalone } from "@/lib/terminal/pwa";

const NUDGE_DISMISSED_KEY = "hive:help-nudge-dismissed";
const subscribeToNothing = () => () => {};

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
  const dialogRef = React.useRef<HTMLDivElement>(null);
  const { getAll, subscribe } = useKeybindings();
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
    keys: ["ctrl+/", "cmd+/"],
    action: () => {
      setOpen((prev) => !prev);
      return false;
    },
    description: "Show keyboard shortcuts",
    category: "general",
    enabledInBrowser: true,
    global: true,
  });

  const entries = React.useSyncExternalStore(subscribe ?? subscribeToNothing, getAll, getAll);
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
      <DialogContent
        ref={dialogRef}
        initialFocus={dialogRef}
        className="max-h-[80vh] overflow-y-auto"
      >
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
                  const platformKeys = entry.keys.filter((key) =>
                    isMac ? key.includes("cmd") : !key.includes("cmd"),
                  );
                  const shortcuts = [...new Set(platformKeys.length ? platformKeys : entry.keys)];
                  return (
                    <div
                      key={entry.id}
                      className="flex flex-wrap items-center justify-between gap-2 rounded-md px-2 py-1.5 text-sm"
                    >
                      <span className={isPwaOnly ? "text-muted-foreground" : ""}>
                        {entry.description}
                        {isPwaOnly && (
                          <Badge variant="outline" className="ml-2 text-[10px]">
                            PWA only
                          </Badge>
                        )}
                      </span>
                      <span className="flex flex-wrap items-center gap-1">
                        {shortcuts.map((key) => (
                          <kbd
                            key={key}
                            className="rounded border border-border bg-muted px-1.5 py-0.5 font-mono text-xs text-muted-foreground"
                          >
                            {formatShortcut([key], isMac)}
                          </kbd>
                        ))}
                      </span>
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
