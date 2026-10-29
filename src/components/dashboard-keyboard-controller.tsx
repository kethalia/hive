"use client";

import { usePathname, useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useRuntimeConfig } from "@/components/runtime-config-provider";
import {
  CommandPalette,
  type CommandPaletteAction,
  type CommandPalettePage,
} from "@/components/terminal/CommandPalette";
import { useIsMobile } from "@/hooks/use-mobile";
import { useDashboardFullscreen } from "@/hooks/useDashboardFullscreen";
import { useGlobalCommandPaletteGesture } from "@/hooks/useGlobalCommandPaletteGesture";
import { useRegisterKeybinding } from "@/hooks/useKeybindings";
import {
  formatShortcut,
  GLOBAL_COMMAND_PALETTE_KEYS,
  MANAGE_WORKSPACES_KEYS,
  WORKSPACE_AGENTS_KEYS,
} from "@/lib/keyboard-shortcuts";
import {
  getGlobalCommandPaletteSources,
  OPEN_GLOBAL_COMMAND_PALETTE_EVENT,
  subscribeGlobalCommandPaletteSources,
} from "@/lib/terminal/global-command-palette";
import {
  type HiveWindowRequest,
  hiveWindowHref,
  requestHiveWindow,
} from "@/lib/workspaces/general-workspace";

const FULLSCREEN_KEYS = ["ctrl+enter", "cmd+enter"] as const;
const TEMPLATES_KEYS = ["ctrl+shift+2", "cmd+shift+2"] as const;
const DIAGNOSTICS_KEYS = ["ctrl+shift+3", "cmd+shift+3"] as const;

export function DashboardKeyboardController() {
  const router = useRouter();
  const { projectDiscoveryEnabled } = useRuntimeConfig();
  const pathname = usePathname();
  const isMobile = useIsMobile();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [sources, setSources] = useState(getGlobalCommandPaletteSources);
  const source = sources.at(-1);
  const { fullscreen, toggleFullscreen } = useDashboardFullscreen();
  const openTool = useCallback(
    (request: HiveWindowRequest) => {
      if (pathname === "/workspaces") requestHiveWindow(request);
      else router.push(hiveWindowHref(request));
    },
    [pathname, router],
  );
  const showSearch = useCallback(() => {
    if (open) return;
    setQuery("");
    source?.onSearchValueChange?.("");
    setOpen(true);
  }, [source, open]);
  useEffect(
    () => subscribeGlobalCommandPaletteSources(() => setSources(getGlobalCommandPaletteSources())),
    [],
  );
  useEffect(() => {
    window.addEventListener(OPEN_GLOBAL_COMMAND_PALETTE_EVENT, showSearch);
    return () => window.removeEventListener(OPEN_GLOBAL_COMMAND_PALETTE_EVENT, showSearch);
  }, [showSearch]);
  const onSourceOpenChange = source?.onOpenChange;
  useEffect(() => {
    onSourceOpenChange?.(open);
    return () => onSourceOpenChange?.(false);
  }, [open, onSourceOpenChange]);
  useGlobalCommandPaletteGesture({ enabled: isMobile && !open, onOpen: showSearch });
  useRegisterKeybinding({
    id: "dashboard:command-palette",
    keys: [...GLOBAL_COMMAND_PALETTE_KEYS],
    action: () => {
      showSearch();
      return false;
    },
    description: "Search Hive",
    category: "general",
    enabledInBrowser: true,
    global: true,
    allowTextEntry: true,
  });
  useRegisterKeybinding({
    id: "dashboard:navigate-workspaces",
    keys: ["ctrl+shift+1", "cmd+shift+1"],
    action: () => {
      if (pathname !== "/workspaces") router.push("/workspaces");
      return false;
    },
    description: "Open workspace",
    category: "navigation",
    enabledInBrowser: true,
    global: true,
    allowTextEntry: true,
  });
  useRegisterKeybinding({
    id: "dashboard:navigate-templates",
    keys: [...TEMPLATES_KEYS],
    action: () => {
      openTool({ tool: "templates" });
      return false;
    },
    description: "Open templates",
    category: "navigation",
    enabledInBrowser: true,
    global: true,
    allowTextEntry: true,
  });
  useRegisterKeybinding({
    id: "dashboard:navigate-terminal-status",
    keys: [...DIAGNOSTICS_KEYS],
    action: () => {
      openTool({ tool: "diagnostics" });
      return false;
    },
    description: "Open diagnostics",
    category: "navigation",
    enabledInBrowser: true,
    global: true,
    allowTextEntry: true,
  });
  useRegisterKeybinding({
    id: "dashboard:toggle-fullscreen",
    keys: [...FULLSCREEN_KEYS],
    action: () => {
      toggleFullscreen();
      return false;
    },
    description: "Toggle fullscreen",
    category: "general",
    enabledInBrowser: true,
    global: true,
    allowTextEntry: true,
  });
  useEffect(() => {
    document.documentElement.dataset.dashboardKeybindingsReady = "true";
    return () => {
      delete document.documentElement.dataset.dashboardKeybindingsReady;
    };
  }, []);
  const actions = useMemo<CommandPaletteAction[]>(
    () => [
      ...(source?.actions ?? []),
      ...(
        [
          [
            "projects",
            "Projects",
            "Browse repositories from your connected GitHub account",
            undefined,
            ["repositories", "github"],
          ],
          [
            "agents",
            "Agents",
            "Find and resume agent conversations",
            WORKSPACE_AGENTS_KEYS,
            ["assistants", "conversations", "codex", "claude"],
          ],
          [
            "settings",
            "Settings",
            "Account, app updates, and notifications",
            undefined,
            ["preferences", "configuration"],
          ],
          [
            "diagnostics",
            "Diagnostics",
            "Inspect terminal connection health",
            DIAGNOSTICS_KEYS,
            ["connection status", "terminal status", "health"],
          ],
          [
            "workspaces",
            "Manage Coder workspaces",
            "Start, stop, and manage environments",
            MANAGE_WORKSPACES_KEYS,
            ["environments", "coder"],
          ],
          [
            "templates",
            "Templates",
            "Review and push Coder workspace templates",
            TEMPLATES_KEYS,
            ["workspace templates"],
          ],
          [
            "logs",
            "Logs",
            "Inspect terminal events across your workspaces",
            undefined,
            ["events", "terminal events"],
          ],
        ] as const
      )
        .filter(([tool]) => tool !== "projects" || projectDiscoveryEnabled)
        .map(([tool, label, description, keys, aliases]) => ({
          id: `dashboard:open-${tool}`,
          label,
          description,
          aliases,
          group: tool === "logs" ? "Logs" : "Hive",
          value: `${label} ${description}`,
          shortcut: keys ? formatShortcut(keys) : undefined,
          icon: "search" as const,
          onSelect: () => openTool({ tool }),
        })),
      {
        id: "dashboard:launch-workspace",
        label: "Launch Coder workspace",
        description: "Create a Coder environment",
        group: "Hive",
        icon: "plus",
        onSelect: () => openTool({ tool: "workspaces", launch: true }),
      },
      {
        id: "dashboard:fullscreen",
        label: fullscreen ? "Exit fullscreen" : "Enter fullscreen",
        group: "Commands",
        shortcut: formatShortcut(FULLSCREEN_KEYS),
        icon: "search",
        onSelect: toggleFullscreen,
      },
    ],
    [source?.actions, openTool, fullscreen, toggleFullscreen, projectDiscoveryEnabled],
  );
  const launcher = useMemo(() => {
    const groups = new Map<string, CommandPaletteAction[]>();
    for (const action of actions) {
      if (action.group === "Hive") continue;
      const group = groups.get(action.group) ?? [];
      group.push(action);
      groups.set(action.group, group);
    }
    const pages: Record<string, CommandPalettePage> = { ...source?.pages };
    const sections: CommandPaletteAction[] = [];
    for (const [group, items] of groups) {
      const id = `section:${group}`;
      const title = group === "Terminals" ? "Terminal" : group;
      pages[id] = {
        title,
        actions: items,
        searchPlaceholder: `Search ${group.toLowerCase()}…`,
        loadingText: ["Terminals", "Projects", "Files", "VS Code", "Logs"].includes(group)
          ? source?.loadingText
          : undefined,
        emptyText: `No matching ${group.toLowerCase()}.`,
      };
      sections.push({
        id,
        label: title,
        group: "Browse",
        aliases: [group],
        description:
          group === "Terminals"
            ? "Create a terminal or open an existing session"
            : group === "Projects"
              ? "Clone a repository or open an existing project"
              : `Browse ${group.toLowerCase()}`,
        icon: group === "Projects" ? "files" : items.find((item) => item.icon !== "plus")?.icon,
        rightLabel: "Browse",
        onSelect: () => ({ page: id }),
      });
    }
    return {
      pages,
      actions: [
        ...sections,
        ...actions.filter(
          (action) => (source?.searchValue ?? query).trim() || action.group === "Hive",
        ),
      ],
    };
  }, [actions, source?.pages, source?.loadingText, source?.searchValue, query]);
  return (
    <CommandPalette
      open={open}
      onOpenChange={setOpen}
      tabs={source?.tabs ?? []}
      onSelectTab={source?.onSelectTab ?? (() => {})}
      onCreateSession={source?.onCreateSession}
      actions={launcher.actions}
      pages={launcher.pages}
      searchValue={source?.searchValue ?? query}
      onSearchValueChange={(value) => {
        setQuery(value);
        source?.onSearchValueChange?.(value);
      }}
      searchPlaceholder="Search Hive…"
      emptyText={source?.emptyText ?? "No matching items."}
      loadingText={source?.loadingText}
    />
  );
}
